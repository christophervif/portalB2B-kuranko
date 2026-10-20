// ═══════════════════════════════════════════════════════════════════════════
//  MÓDULO: Propuestas de reposición de consignación
//  Kuranko arma una propuesta de qué reponer en la consignación de una tienda;
//  la tienda la ve en su portal y la acepta (puede bajar cantidades) o la rechaza.
//  Frontend admin: vista "Propuestas" en public/clientes-gestion.html.
//  Frontend cliente: pestaña "Propuestas" en public/index.html.
//
//  Sugerencias OBLIGATORIAS (las calcula el sistema):
//    producto que se VENDIÓ desde esa consignación en la ventana (90 d por defecto)
//    y que hoy está AGOTADO en la tienda (disponible 0). Cantidad sugerida = lo
//    que se vendió en la ventana, limitado al stock propio de Kuranko.
//    Si Kuranko no tiene stock propio, se muestra aparte ("no se puede reponer").
//  El resto (lo que "quizás" haga falta, novedades, etc.) lo agrega el equipo a
//  mano buscando en el catálogo: queda marcado como "manual".
//
//  Estados: borrador → enviada → aceptada | rechazada → despachada
//           (borrador/enviada → anulada). Una consignación tiene como máximo una
//           propuesta abierta (borrador o enviada) a la vez.
//  Nada de esto toca el ERP: la transferencia/guía se hace en el ERP como siempre;
//  aquí solo se marca "despachada" con el número de guía.
//
//  Tablas (base del PORTAL): cons_propuestas, cons_propuesta_items.
//  Permiso admin: clientes_gestion. Cliente: su propio token del portal.
// ═══════════════════════════════════════════════════════════════════════════

const VENTANAS = [30, 60, 90, 180, 365];
const DEF_VENTANA = 90;
const ABIERTAS = ['borrador', 'enviada'];

const esc = t => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const entero = (v, min, max) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min; };
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// ═══ Cálculo puro de las sugerencias obligatorias (se exporta para pruebas) ═══
//  vendidas: [{ vid, unidades }]   ventas que salieron de la consignación en la ventana
//  stockConsig: { [vid]: disponible en la consignación }
//  cat: { [vid]: { sku, nombre, stock (propio), precio } }
function sugerirObligatorias(vendidas, stockConsig, cat, ventana) {
  const reponibles = [], sinStock = [];
  vendidas.forEach(v => {
    const und = Math.round(Number(v.unidades) || 0);
    if (und <= 0) return;
    const enTienda = Number(stockConsig[v.vid] || 0);
    if (enTienda > 0) return;                       // aún tiene: no es obligatorio
    const c = cat[v.vid] || {};
    const propio = Math.max(0, Math.floor(Number(c.stock) || 0));
    const fila = {
      vid: Number(v.vid), sku: c.sku || '', nombre: c.nombre || `Producto ${v.vid}`, tipo: 'obligatorio',
      motivo: `Agotado en tienda · vendió ${und} en ${ventana} d`,
      vendidas: und, stock_consig: enTienda, stock_propio: propio, precio: c.precio != null ? Number(c.precio) : null,
      cantidad: Math.min(und, propio)
    };
    if (propio > 0) reponibles.push(fila); else sinStock.push({ ...fila, cantidad: 0, motivo: fila.motivo + ' · Kuranko sin stock' });
  });
  const orden = (a, b) => b.vendidas - a.vendidas || a.nombre.localeCompare(b.nombre);
  return { reponibles: reponibles.sort(orden), sin_stock: sinStock.sort(orden) };
}

module.exports = function registrarPropuestas({ app, authAdmin, requiereModulo, prodPool, portalPool,
  authCliente, catalogo, grupos, portal }) {
  const mGest = requiereModulo('clientes_gestion');

  // ─────────── Tablas ───────────
  let listas = false;
  async function prepararTablas() {
    if (listas) return;
    await portalPool.query(`
      CREATE TABLE IF NOT EXISTS cons_propuestas (
        id INT AUTO_INCREMENT PRIMARY KEY,
        portal_user_id INT NOT NULL,
        location_id BIGINT NOT NULL,
        estado VARCHAR(20) NOT NULL DEFAULT 'borrador',
        ventana INT NOT NULL DEFAULT ${DEF_VENTANA},
        nota VARCHAR(1000) NOT NULL DEFAULT '',
        nota_cliente VARCHAR(1000) NOT NULL DEFAULT '',
        factura_ruc VARCHAR(20) NULL,
        factura_nombre VARCHAR(255) NULL,
        creado_por VARCHAR(80) NOT NULL DEFAULT '',
        creado_en DATETIME DEFAULT CURRENT_TIMESTAMP,
        actualizado_en DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        enviado_en DATETIME NULL, enviado_por VARCHAR(80) NULL,
        respondido_en DATETIME NULL, respondido_por VARCHAR(120) NULL,
        despachado_en DATETIME NULL, despachado_por VARCHAR(80) NULL, guia VARCHAR(80) NULL,
        KEY ix_user (portal_user_id), KEY ix_loc (location_id), KEY ix_estado (estado)
      )`);
    await portalPool.query(`
      CREATE TABLE IF NOT EXISTS cons_propuesta_items (
        id INT AUTO_INCREMENT PRIMARY KEY,
        propuesta_id INT NOT NULL,
        vid BIGINT NOT NULL,
        sku VARCHAR(80) NOT NULL DEFAULT '',
        nombre VARCHAR(300) NOT NULL DEFAULT '',
        tipo VARCHAR(20) NOT NULL DEFAULT 'manual',
        motivo VARCHAR(255) NOT NULL DEFAULT '',
        cantidad INT NOT NULL DEFAULT 0,
        cantidad_aceptada INT NULL,
        vendidas INT NOT NULL DEFAULT 0,
        stock_consig INT NOT NULL DEFAULT 0,
        stock_propio INT NOT NULL DEFAULT 0,
        precio DECIMAL(12,2) NULL,
        KEY ix_prop (propuesta_id)
      )`);
    listas = true;
  }

  const quien = req => (req.admin && req.admin.usuario) || 'admin';

  // Catálogo (del cotizador): vid → { sku, nombre, stock propio, precio }
  async function mapaCatalogo(vids) {
    const out = {};
    try {
      const cat = await catalogo();
      const set = vids ? new Set(vids.map(Number)) : null;
      cat.forEach(c => { if (!set || set.has(Number(c.vid))) out[c.vid] = { sku: c.sku, nombre: c.nombre, stock: c.stock, precio: c.precio_normal || null }; });
    } catch (e) { console.error('[propuestas] catálogo', e.message); }
    return out;
  }

  // Sugerencias obligatorias de una consignación
  async function calcularSugerencias(locId, ventana) {
    const [vendidas] = await prodPool.query(`
      SELECT product_variation_id AS vid, SUM(ABS(quantity)) AS unidades
      FROM stock_movements
      WHERE type='sale' AND location_from_id=? AND movement_date >= DATE_SUB(NOW(), INTERVAL ? DAY)
      GROUP BY product_variation_id`, [locId, ventana]);
    const [st] = await prodPool.query(
      `SELECT product_variation_id AS vid, GREATEST(quantity - reserved_quantity, 0) AS disp
       FROM location_stocks WHERE location_id=?`, [locId]);
    const stockConsig = {}; st.forEach(r => { stockConsig[r.vid] = Number(r.disp) || 0; });
    const cat = await mapaCatalogo(vendidas.map(v => v.vid));
    return sugerirObligatorias(vendidas, stockConsig, cat, ventana);
  }

  // Acceso que ve esta consignación (principal o adicional)
  async function accesoDeLoc(locId) {
    const [rows] = await portalPool.query(`
      SELECT u.id, u.username, u.nombre_cliente, u.customer_id, u.activo FROM portal_users u
      WHERE u.location_id=? OR u.id IN (SELECT portal_user_id FROM portal_user_consignaciones WHERE location_id=?)
      ORDER BY u.activo DESC, u.id`, [locId, locId]);
    return rows;
  }
  async function nombreLoc(locId) {
    const [[l]] = await prodPool.query('SELECT id, name, is_active FROM locations WHERE id=? AND type=\'consignment\' LIMIT 1', [locId]);
    return l || null;
  }
  async function leerPropuesta(id) {
    const [[p]] = await portalPool.query('SELECT * FROM cons_propuestas WHERE id=?', [id]);
    if (!p) return null;
    const [items] = await portalPool.query('SELECT * FROM cons_propuesta_items WHERE propuesta_id=? ORDER BY tipo=\'manual\', id', [id]);
    const [[u]] = await portalPool.query('SELECT id, username, nombre_cliente, customer_id FROM portal_users WHERE id=?', [p.portal_user_id]);
    const l = await nombreLoc(p.location_id).catch(() => null);
    return { ...p, consignacion: l ? l.name : `Consignación ${p.location_id}`, cliente: u ? u.nombre_cliente : '', usuario: u ? u.username : '',
      customer_id: u ? u.customer_id : null,
      items: items.map(i => ({ ...i, precio: i.precio != null ? Number(i.precio) : null })),
      unidades: items.reduce((a, i) => a + i.cantidad, 0),
      unidades_aceptadas: items.reduce((a, i) => a + (i.cantidad_aceptada || 0), 0) };
  }

  // ─────────── Correo (Resend) ───────────
  async function enviarCorreo({ to, cc, subject, html, text }) {
    if (!process.env.RESEND_API_KEY) return false;
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: process.env.RESEND_FROM || 'Portal Kuranko <noreply@kuranko.pe>', to, cc, reply_to: 'ventas@kuranko.pe', subject, html, text })
      });
      if (!r.ok) console.error('[propuestas] Resend falló:', r.status, await r.text());
      return r.ok;
    } catch (e) { console.error('[propuestas] correo', e.message); return false; }
  }
  const internos = () => {
    const vistos = new Set();
    return [...(process.env.VENTAS_EMAIL || 'ventas@kuranko.pe').split(','), 'info@kuranko.pe'].map(x => x.trim())
      .filter(x => /@/.test(x) && !vistos.has(x.toLowerCase()) && vistos.add(x.toLowerCase()));
  };
  function tablaHtml(p, aceptadas) {
    const filas = p.items.filter(i => !aceptadas || i.cantidad_aceptada > 0).map((i, n) => `
      <tr><td style="padding:6px 10px;border:1px solid #e0e0e0;text-align:center">${n + 1}</td>
        <td style="padding:6px 10px;border:1px solid #e0e0e0;font-family:monospace">${esc(i.sku) || '—'}</td>
        <td style="padding:6px 10px;border:1px solid #e0e0e0">${esc(i.nombre)}</td>
        <td style="padding:6px 10px;border:1px solid #e0e0e0;text-align:center"><b>${aceptadas ? i.cantidad_aceptada : i.cantidad}</b>${aceptadas && i.cantidad_aceptada !== i.cantidad ? ` <span style="color:#b45309">(propuesto ${i.cantidad})</span>` : ''}</td></tr>`).join('');
    return `<table style="border-collapse:collapse;width:100%;font-size:14px"><thead><tr style="background:#000726;color:#fff">
      <th style="padding:6px 10px">N°</th><th style="padding:6px 10px;text-align:left">SKU</th><th style="padding:6px 10px;text-align:left">Producto</th><th style="padding:6px 10px">Cantidad</th></tr></thead><tbody>${filas}</tbody></table>`;
  }
  const facturaTxt = p => p.factura_ruc ? `Se factura a: ${p.factura_nombre ? p.factura_nombre + ' — ' : ''}RUC ${p.factura_ruc}` : 'RUC de facturación por definir (verificar con la guía).';

  async function correoEnvio(p, origen) {
    // Correo del cliente: el de su RUC principal o, si no tiene, el de sus RUC adicionales
    let ids = [p.customer_id].filter(Boolean);
    try { if (grupos && grupos.grupoDe) { const g = await grupos.grupoDe(p.portal_user_id); if (g && g.ids.length) ids = g.ids; } } catch (e) { /* usa el principal */ }
    const email = portal && portal.correoEmpresa ? await portal.correoEmpresa(ids) : null;
    const to = email ? [email] : internos().slice(0, 1);
    const cc = internos().filter(x => !to.map(t => t.toLowerCase()).includes(x.toLowerCase()));
    const link = origen ? origen + '/' : 'el Portal Kuranko';
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;max-width:640px">
      <h2 style="color:#000726;margin-bottom:4px">Propuesta de reposición de consignación</h2>
      <p>Hola ${esc(p.cliente)}, te enviamos una propuesta para reponer tu consignación <b>${esc(p.consignacion)}</b> (${p.unidades} unidades).</p>
      ${p.nota ? `<p style="background:#eef2ff;padding:10px 14px;border-radius:6px">${esc(p.nota)}</p>` : ''}
      ${tablaHtml(p)}
      <p style="margin-top:14px">Revísala y acéptala (puedes bajar cantidades) en <b>Propuestas</b> dentro de tu portal: ${origen ? `<a href="${esc(link)}">${esc(link)}</a>` : esc(link)}</p>
      <p style="color:#666;font-size:13px">${esc(facturaTxt(p))}</p></div>`;
    const text = `Propuesta de reposición de consignación — ${p.consignacion}\n\n` +
      p.items.map((i, n) => `${n + 1}. [${i.sku || '—'}] ${i.nombre} — ${i.cantidad}`).join('\n') +
      `\n\nRevísala y acéptala en "Propuestas" dentro de tu portal: ${link}\n${facturaTxt(p)}`;
    return enviarCorreo({ to, cc, subject: `Propuesta de reposición — ${p.consignacion}`, html, text });
  }
  async function correoRespuesta(p) {
    const acepta = p.estado === 'aceptada';
    const cambios = p.items.some(i => i.cantidad_aceptada !== i.cantidad);
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;max-width:640px">
      <h2 style="color:${acepta ? '#000726' : '#b42318'};margin-bottom:4px">Propuesta ${acepta ? 'ACEPTADA' : 'RECHAZADA'}${acepta && cambios ? ' con cambios' : ''} — ${esc(p.cliente)}</h2>
      <p>Consignación: <b>${esc(p.consignacion)}</b> · Propuesta N° ${p.id} · Respondió: ${esc(p.respondido_por)}</p>
      ${p.nota_cliente ? `<p style="background:#fef3c7;padding:10px 14px;border-radius:6px">Comentario del cliente: ${esc(p.nota_cliente)}</p>` : ''}
      ${acepta ? `<p><b>Preparar transferencia (guía) a la consignación con ${p.unidades_aceptadas} unidades:</b></p>${tablaHtml(p, true)}
      <p style="color:#666;font-size:13px">${esc(facturaTxt(p))}. Al despacharla, márcala como "despachada" en Gestión de clientes → Propuestas.</p>` : ''}</div>`;
    const text = `Propuesta ${acepta ? 'ACEPTADA' : 'RECHAZADA'} — ${p.cliente} — ${p.consignacion} (N° ${p.id})\n` +
      (p.nota_cliente ? `Comentario: ${p.nota_cliente}\n` : '') +
      (acepta ? '\n' + p.items.filter(i => i.cantidad_aceptada > 0).map((i, n) => `${n + 1}. [${i.sku || '—'}] ${i.nombre} — ${i.cantidad_aceptada}`).join('\n') : '');
    const [to, ...cc] = internos();
    return enviarCorreo({ to: [to], cc, subject: `Propuesta ${acepta ? 'aceptada' : 'rechazada'} — ${p.cliente} — ${p.consignacion}`, html, text });
  }

  // ═════════════════ ADMIN ═════════════════
  // Lista de propuestas (filtro opcional por estado / consignación)
  app.get('/api/propuestas', authAdmin, mGest, async (req, res) => {
    try {
      await prepararTablas();
      const w = [], p = [];
      if (req.query.estado) { w.push('pr.estado=?'); p.push(String(req.query.estado)); }
      if (req.query.location_id) { w.push('pr.location_id=?'); p.push(Number(req.query.location_id)); }
      const [rows] = await portalPool.query(`
        SELECT pr.*, u.nombre_cliente AS cliente, u.username AS usuario,
          (SELECT COUNT(*) FROM cons_propuesta_items i WHERE i.propuesta_id=pr.id) AS lineas,
          (SELECT COALESCE(SUM(cantidad),0) FROM cons_propuesta_items i WHERE i.propuesta_id=pr.id) AS unidades,
          (SELECT COALESCE(SUM(cantidad_aceptada),0) FROM cons_propuesta_items i WHERE i.propuesta_id=pr.id) AS unidades_aceptadas,
          (SELECT COUNT(*) FROM cons_propuesta_items i WHERE i.propuesta_id=pr.id AND i.tipo='obligatorio') AS obligatorias
        FROM cons_propuestas pr LEFT JOIN portal_users u ON u.id=pr.portal_user_id
        ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY pr.id DESC LIMIT 300`, p);
      const locIds = [...new Set(rows.map(r => r.location_id))];
      const nombres = {};
      if (locIds.length) {
        const [ls] = await prodPool.query('SELECT id, name FROM locations WHERE id IN (?)', [locIds]);
        ls.forEach(l => { nombres[l.id] = l.name; });
      }
      res.json(rows.map(r => ({ ...r, consignacion: nombres[r.location_id] || `Consignación ${r.location_id}`,
        unidades: Number(r.unidades), unidades_aceptadas: Number(r.unidades_aceptadas) })));
    } catch (e) { res.status(500).json({ error: 'No se pudieron leer las propuestas: ' + e.message }); }
  });

  app.get('/api/propuestas/:id', authAdmin, mGest, async (req, res) => {
    try {
      await prepararTablas();
      const p = await leerPropuesta(req.params.id);
      if (!p) return res.status(404).json({ error: 'Propuesta no encontrada' });
      res.json(p);
    } catch (e) { res.status(500).json({ error: 'Error: ' + e.message }); }
  });

  // Vista previa de sugerencias obligatorias (sin guardar)
  app.get('/api/propuestas/sugerencias/:locId', authAdmin, mGest, async (req, res) => {
    const ventana = VENTANAS.includes(Number(req.query.ventana)) ? Number(req.query.ventana) : DEF_VENTANA;
    try { res.json({ ventana, ...(await calcularSugerencias(Number(req.params.locId), ventana)) }); }
    catch (e) { res.status(500).json({ error: 'No se pudieron calcular las sugerencias: ' + e.message }); }
  });

  // Crear propuesta (borrador) para una consignación, con las obligatorias ya cargadas
  app.post('/api/propuestas', authAdmin, mGest, async (req, res) => {
    const locId = Number((req.body || {}).location_id);
    const ventana = VENTANAS.includes(Number((req.body || {}).ventana)) ? Number(req.body.ventana) : DEF_VENTANA;
    if (!locId) return res.status(400).json({ error: 'Elige una consignación' });
    try {
      await prepararTablas();
      const l = await nombreLoc(locId);
      if (!l) return res.status(404).json({ error: 'Consignación no encontrada en el ERP' });
      const accs = (await accesoDeLoc(locId)).filter(a => Number(a.activo));
      if (!accs.length) return res.status(400).json({ error: `"${l.name}" no tiene un acceso activo al portal: asígnala primero a un cliente.` });
      const [ab] = await portalPool.query(`SELECT id, estado FROM cons_propuestas WHERE location_id=? AND estado IN (?) LIMIT 1`, [locId, ABIERTAS]);
      if (ab.length) return res.status(409).json({ error: `Ya hay una propuesta ${ab[0].estado} para "${l.name}" (N° ${ab[0].id}). Ábrela o anúlala primero.`, id: ab[0].id });
      let fact = {};
      try { if (grupos && grupos.facturacionDe) fact = (await grupos.facturacionDe([locId]))[locId] || {}; } catch (e) { fact = {}; }
      const sug = await calcularSugerencias(locId, ventana);
      const [r] = await portalPool.query(
        `INSERT INTO cons_propuestas (portal_user_id, location_id, estado, ventana, factura_ruc, factura_nombre, creado_por) VALUES (?,?,?,?,?,?,?)`,
        [accs[0].id, locId, 'borrador', ventana, fact.estado === 'ok' ? fact.ruc : null, fact.estado === 'ok' ? (fact.nombre || null) : null, quien(req)]);
      const id = r.insertId;
      if (sug.reponibles.length) {
        await portalPool.query(`INSERT INTO cons_propuesta_items
          (propuesta_id, vid, sku, nombre, tipo, motivo, cantidad, vendidas, stock_consig, stock_propio, precio) VALUES ?`,
          [sug.reponibles.map(i => [id, i.vid, i.sku, i.nombre.slice(0, 300), 'obligatorio', i.motivo, i.cantidad, i.vendidas, i.stock_consig, i.stock_propio, i.precio])]);
      }
      res.json({ ok: true, id, obligatorias: sug.reponibles.length, sin_stock: sug.sin_stock, varios_accesos: accs.length > 1 ? accs.map(a => a.nombre_cliente) : [] });
    } catch (e) { res.status(500).json({ error: 'Error al crear la propuesta: ' + e.message }); }
  });

  // Guardar el borrador: nota + líneas (cantidades, quitar, agregar manuales)
  //  body: { nota, items: [{ id? , vid, cantidad }] }  — reemplaza las líneas
  app.put('/api/propuestas/:id', authAdmin, mGest, async (req, res) => {
    const { nota, items } = req.body || {};
    if (!Array.isArray(items)) return res.status(400).json({ error: 'Faltan las líneas' });
    const conn = await portalPool.getConnection();
    try {
      await prepararTablas();
      const [[p]] = await conn.query('SELECT * FROM cons_propuestas WHERE id=?', [req.params.id]);
      if (!p) { conn.release(); return res.status(404).json({ error: 'Propuesta no encontrada' }); }
      if (p.estado !== 'borrador') { conn.release(); return res.status(409).json({ error: 'Solo se puede editar un borrador. Si ya la enviaste, anúlala y crea otra.' }); }
      const [prev] = await conn.query('SELECT * FROM cons_propuesta_items WHERE propuesta_id=?', [p.id]);
      const prevDe = new Map(prev.map(i => [Number(i.vid), i]));
      const vistos = new Set();
      const limpias = items.map(i => ({ vid: Number(i.vid), cantidad: entero(i.cantidad, 0, 9999) }))
        .filter(i => i.vid && i.cantidad > 0 && !vistos.has(i.vid) && vistos.add(i.vid));
      const nuevos = limpias.filter(i => !prevDe.has(i.vid)).map(i => i.vid);
      const cat = nuevos.length ? await mapaCatalogo(nuevos) : {};
      let stockLoc = {};
      if (nuevos.length) {
        const [st] = await prodPool.query(`SELECT product_variation_id AS vid, GREATEST(quantity - reserved_quantity,0) AS d FROM location_stocks WHERE location_id=? AND product_variation_id IN (?)`, [p.location_id, nuevos]);
        st.forEach(r => { stockLoc[r.vid] = Number(r.d); });
      }
      const faltan = nuevos.filter(v => !cat[v]);
      if (faltan.length) { conn.release(); return res.status(400).json({ error: `Producto no encontrado en el catálogo (id ${faltan.join(', ')})` }); }
      await conn.beginTransaction();
      await conn.query('UPDATE cons_propuestas SET nota=? WHERE id=?', [String(nota || '').slice(0, 1000), p.id]);
      await conn.query('DELETE FROM cons_propuesta_items WHERE propuesta_id=?', [p.id]);
      if (limpias.length) {
        await conn.query(`INSERT INTO cons_propuesta_items
          (propuesta_id, vid, sku, nombre, tipo, motivo, cantidad, vendidas, stock_consig, stock_propio, precio) VALUES ?`,
          [limpias.map(i => {
            const a = prevDe.get(i.vid);
            if (a) return [p.id, i.vid, a.sku, a.nombre, a.tipo, a.motivo, i.cantidad, a.vendidas, a.stock_consig, a.stock_propio, a.precio];
            const c = cat[i.vid];
            return [p.id, i.vid, c.sku || '', String(c.nombre || '').slice(0, 300), 'manual', 'Agregado por Kuranko', i.cantidad, 0, stockLoc[i.vid] || 0, Math.max(0, Math.floor(c.stock || 0)), c.precio];
          })]);
      }
      await conn.commit(); conn.release();
      res.json({ ok: true, propuesta: await leerPropuesta(p.id) });
    } catch (e) {
      try { await conn.rollback(); } catch (_) {}
      conn.release();
      res.status(500).json({ error: 'Error al guardar: ' + e.message });
    }
  });

  // Recalcular obligatorias del borrador (mantiene las manuales y las cantidades ya editadas)
  app.post('/api/propuestas/:id/recalcular', authAdmin, mGest, async (req, res) => {
    try {
      await prepararTablas();
      const [[p]] = await portalPool.query('SELECT * FROM cons_propuestas WHERE id=?', [req.params.id]);
      if (!p) return res.status(404).json({ error: 'Propuesta no encontrada' });
      if (p.estado !== 'borrador') return res.status(409).json({ error: 'Solo se recalcula un borrador' });
      const ventana = VENTANAS.includes(Number((req.body || {}).ventana)) ? Number(req.body.ventana) : p.ventana;
      const sug = await calcularSugerencias(p.location_id, ventana);
      const [prev] = await portalPool.query('SELECT vid FROM cons_propuesta_items WHERE propuesta_id=?', [p.id]);
      const ya = new Set(prev.map(i => Number(i.vid)));
      const nuevas = sug.reponibles.filter(i => !ya.has(i.vid));
      if (nuevas.length) await portalPool.query(`INSERT INTO cons_propuesta_items
          (propuesta_id, vid, sku, nombre, tipo, motivo, cantidad, vendidas, stock_consig, stock_propio, precio) VALUES ?`,
        [nuevas.map(i => [p.id, i.vid, i.sku, i.nombre.slice(0, 300), 'obligatorio', i.motivo, i.cantidad, i.vendidas, i.stock_consig, i.stock_propio, i.precio])]);
      await portalPool.query('UPDATE cons_propuestas SET ventana=? WHERE id=?', [ventana, p.id]);
      res.json({ ok: true, agregadas: nuevas.length, sin_stock: sug.sin_stock, propuesta: await leerPropuesta(p.id) });
    } catch (e) { res.status(500).json({ error: 'Error: ' + e.message }); }
  });

  // Enviar al cliente (borrador → enviada) + correo al cliente
  app.post('/api/propuestas/:id/enviar', authAdmin, mGest, async (req, res) => {
    try {
      await prepararTablas();
      const p0 = await leerPropuesta(req.params.id);
      if (!p0) return res.status(404).json({ error: 'Propuesta no encontrada' });
      if (p0.estado !== 'borrador') return res.status(409).json({ error: 'Ya fue enviada' });
      if (!p0.items.length || !p0.unidades) return res.status(400).json({ error: 'La propuesta no tiene productos' });
      const [r] = await portalPool.query(`UPDATE cons_propuestas SET estado='enviada', enviado_en=NOW(), enviado_por=? WHERE id=? AND estado='borrador'`, [quien(req), p0.id]);
      if (!r.affectedRows) return res.status(409).json({ error: 'Ya fue enviada' });
      const p = await leerPropuesta(p0.id);
      const origen = (process.env.PORTAL_PUBLICO_URL || `${(req.get('x-forwarded-proto') || req.protocol).split(',')[0]}://${req.get('host')}`).replace(/\/$/, '');
      const correo = await correoEnvio(p, origen);
      res.json({ ok: true, correo_enviado: correo, propuesta: p });
    } catch (e) { res.status(500).json({ error: 'Error al enviar: ' + e.message }); }
  });

  app.post('/api/propuestas/:id/anular', authAdmin, mGest, async (req, res) => {
    try {
      await prepararTablas();
      const [r] = await portalPool.query(`UPDATE cons_propuestas SET estado='anulada' WHERE id=? AND estado IN (?)`, [req.params.id, ABIERTAS]);
      if (!r.affectedRows) return res.status(409).json({ error: 'Solo se anula un borrador o una propuesta enviada sin responder' });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'Error: ' + e.message }); }
  });

  // Marcar despachada (la transferencia ya se hizo en el ERP)
  app.post('/api/propuestas/:id/despachar', authAdmin, mGest, async (req, res) => {
    const guia = String((req.body || {}).guia || '').trim().slice(0, 80);
    try {
      await prepararTablas();
      const [r] = await portalPool.query(
        `UPDATE cons_propuestas SET estado='despachada', despachado_en=NOW(), despachado_por=?, guia=? WHERE id=? AND estado='aceptada'`,
        [quien(req), guia || null, req.params.id]);
      if (!r.affectedRows) return res.status(409).json({ error: 'Solo se despacha una propuesta aceptada' });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'Error: ' + e.message }); }
  });

  // Buscar productos del catálogo para agregar a mano (con stock propio y en esa consignación)
  app.get('/api/propuestas/productos/buscar', authAdmin, mGest, async (req, res) => {
    const q = norm(req.query.q).trim();
    const locId = Number(req.query.location_id) || null;
    if (q.length < 2) return res.json([]);
    try {
      const partes = q.split(/\s+/).filter(Boolean);
      const cat = await catalogo();
      const hits = cat.filter(c => { const t = norm((c.sku || '') + ' ' + (c.nombre || '')); return partes.every(p => t.includes(p)); })
        .sort((a, b) => (b.stock > 0) - (a.stock > 0) || b.stock - a.stock).slice(0, 30);
      const enLoc = {};
      if (locId && hits.length) {
        const [st] = await prodPool.query(`SELECT product_variation_id AS vid, GREATEST(quantity - reserved_quantity,0) AS d FROM location_stocks WHERE location_id=? AND product_variation_id IN (?)`,
          [locId, hits.map(h => h.vid)]);
        st.forEach(r => { enLoc[r.vid] = Number(r.d); });
      }
      res.json(hits.map(h => ({ vid: h.vid, sku: h.sku, nombre: h.nombre, stock_propio: h.stock, en_consignacion: enLoc[h.vid] || 0, precio: h.precio_normal || null })));
    } catch (e) { res.status(500).json({ error: 'Error al buscar: ' + e.message }); }
  });

  // ═════════════════ PORTAL DEL CLIENTE ═════════════════
  // Propuestas visibles para el cliente (no ve borradores ni anuladas)
  async function propuestasCliente(req) {
    await prepararTablas();
    const locs = req.cliente.locs || [];
    const [rows] = await portalPool.query(`
      SELECT id FROM cons_propuestas
      WHERE estado IN ('enviada','aceptada','rechazada','despachada')
        AND (portal_user_id=? ${locs.length ? 'OR location_id IN (?)' : ''})
      ORDER BY estado='enviada' DESC, id DESC LIMIT 30`,
      locs.length ? [req.cliente.portal_user_id, locs] : [req.cliente.portal_user_id]);
    const out = [];
    for (const r of rows) {
      const p = await leerPropuesta(r.id);
      // Al cliente no se le muestran datos internos (stock propio de Kuranko, quién la creó)
      out.push({ id: p.id, estado: p.estado, consignacion: p.consignacion, nota: p.nota, nota_cliente: p.nota_cliente,
        factura_ruc: p.factura_ruc, factura_nombre: p.factura_nombre, enviado_en: p.enviado_en, respondido_en: p.respondido_en,
        despachado_en: p.despachado_en, guia: p.guia, unidades: p.unidades, unidades_aceptadas: p.unidades_aceptadas,
        items: p.items.map(i => ({ id: i.id, sku: i.sku, nombre: i.nombre, tipo: i.tipo, cantidad: i.cantidad, cantidad_aceptada: i.cantidad_aceptada,
          vendidas: i.vendidas, motivo: i.tipo === 'obligatorio' ? `Se agotó en tu tienda · vendiste ${i.vendidas}` : 'Sugerido por Kuranko' })) });
    }
    return out;
  }
  app.get('/portal/propuestas', authCliente, async (req, res) => {
    try { res.json(await propuestasCliente(req)); }
    catch (e) { res.status(500).json({ error: 'Error al consultar propuestas' }); }
  });

  // Responder: { accion: 'aceptar'|'rechazar', items: [{ id, cantidad }], comentario }
  //  Al aceptar, cada línea puede quedar entre 0 y lo propuesto (no puede pedir más).
  app.post('/portal/propuestas/:id/responder', authCliente, async (req, res) => {
    const { accion, items, comentario } = req.body || {};
    if (!['aceptar', 'rechazar'].includes(accion)) return res.status(400).json({ error: 'Acción no válida' });
    const conn = await portalPool.getConnection();
    try {
      await prepararTablas();
      const locs = req.cliente.locs || [];
      const [[p]] = await conn.query('SELECT * FROM cons_propuestas WHERE id=?', [req.params.id]);
      if (!p || !(Number(p.portal_user_id) === Number(req.cliente.portal_user_id) || locs.includes(Number(p.location_id)))) {
        conn.release(); return res.status(404).json({ error: 'Propuesta no encontrada' });
      }
      if (p.estado !== 'enviada') { conn.release(); return res.status(409).json({ error: 'Esta propuesta ya fue respondida o anulada' }); }
      const [lineas] = await conn.query('SELECT id, cantidad FROM cons_propuesta_items WHERE propuesta_id=?', [p.id]);
      const pedido = new Map((Array.isArray(items) ? items : []).map(i => [Number(i.id), i.cantidad]));
      const respondio = req.cliente.via_admin ? `Kuranko (${req.cliente.via_admin}) desde "ver como cliente"` : `${req.cliente.nombre || ''} (${req.cliente.ruc || ''})`.trim();
      await conn.beginTransaction();
      let total = 0;
      for (const l of lineas) {
        const cant = accion === 'aceptar' ? (pedido.has(l.id) ? entero(pedido.get(l.id), 0, l.cantidad) : l.cantidad) : 0;
        total += cant;
        await conn.query('UPDATE cons_propuesta_items SET cantidad_aceptada=? WHERE id=?', [cant, l.id]);
      }
      if (accion === 'aceptar' && total === 0) { await conn.rollback(); conn.release(); return res.status(400).json({ error: 'Pusiste todo en 0: si no quieres nada, usa "Rechazar".' }); }
      const [r] = await conn.query(
        `UPDATE cons_propuestas SET estado=?, respondido_en=NOW(), respondido_por=?, nota_cliente=? WHERE id=? AND estado='enviada'`,
        [accion === 'aceptar' ? 'aceptada' : 'rechazada', respondio.slice(0, 120), String(comentario || '').slice(0, 1000), p.id]);
      if (!r.affectedRows) { await conn.rollback(); conn.release(); return res.status(409).json({ error: 'Esta propuesta ya fue respondida' }); }
      await conn.commit(); conn.release();
      const completa = await leerPropuesta(p.id);
      const correo = await correoRespuesta(completa);
      res.json({ ok: true, estado: completa.estado, unidades_aceptadas: completa.unidades_aceptadas, correo_enviado: correo });
    } catch (e) {
      try { await conn.rollback(); } catch (_) {}
      conn.release();
      res.status(500).json({ error: 'Error al responder: ' + e.message });
    }
  });

  return { prepararTablas };
};

module.exports._test = { sugerirObligatorias };
