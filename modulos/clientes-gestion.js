// ═══════════════════════════════════════════════════════════════════════════
//  MÓDULO: Gestión de clientes del portal B2B
//  Backend aquí; frontend propio en public/clientes-gestion.html (iframe en el
//  panel). Antes vivía repartido entre modulos/accesos.js y admin.html.
//
//  Qué resuelve
//  · Accesos al portal: crear, activar/desactivar, resetear clave, ver como cliente.
//  · Consignaciones (puntos de venta): vincular, y ver cuáles NO tienen empresa.
//  · Empresas con varios RUC (ej. Puntobike SAC → Frisancho Pereyra Sadith):
//    un acceso puede agrupar varios RUC del ERP. El portal muestra las ventas y
//    pagos de todos, el cliente entra con cualquiera de ellos y Clientes BI los
//    cuenta como un solo cliente. Un RUC adicional se puede volver "principal"
//    cuando el anterior se da de baja.
//  · RUC de facturación: sale de las NOTAS de cada consignación en el ERP (un RUC
//    de 11 dígitos). El reporte de venta dice "Facturar a…" y el cliente no elige.
//    Sin RUC o con varios → "RUC por definir": el vendedor verifica con la guía.
//    Un acceso puede ver varias consignaciones (ej. mismo local, una por RUC).
//  · Alertas: consignación inactiva o compartida, nombre/RUC desfasado con el ERP,
//    sin correo (no le llega el reporte), clave inicial sin cambiar, ventas de su
//    consignación facturadas a otro RUC (pista de un segundo RUC), etc.
//
//  Tablas propias (base del PORTAL, nunca el ERP)
//    portal_user_rucs  RUC adicionales de un acceso (customer_id único)
//    portal_user_consignaciones  consignaciones adicionales de un acceso
//    portal_users      + ultimo_login, + clave_inicial (columnas nuevas)
//
//  Permiso: clientes_gestion (todas las rutas).
// ═══════════════════════════════════════════════════════════════════════════

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const DIAS_VENTAS_CONSIG = 180;      // ventana para "quién compra en esta consignación"
const DIAS_SIN_VENTAS = 180;         // alerta "sin ventas recientes"
const TTL_GRUPO = 60 * 1000;         // caché del grupo de RUC por acceso (portal)
const TTL_ALIAS = 5 * 60 * 1000;     // caché del mapa de RUC unidos (BI)

const limpiarDoc = d => String(d || '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
const nombreParte = p => {
  if (!p) return '';
  const bn = (p.business_name || '').trim();
  const pn = `${p.first_name || ''} ${p.last_name || ''}`.trim();
  return ((p.is_company ? (bn || pn) : (pn || bn)) || '').replace(/\s+/g, ' ').trim();
};
// Comparación de nombres tolerante: sin tildes, puntuación ni "S.A.C." / "E.I.R.L."
const normNombre = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toUpperCase().replace(/\b(S\.?\s?A\.?\s?C\.?|S\.?\s?A\.?|E\.?\s?I\.?\s?R\.?\s?L\.?|S\.?\s?R\.?\s?L\.?)\s*$/g, '')
  .replace(/[^A-Z0-9]/g, '');
const normTel = t => { const d = String(t || '').replace(/\D/g, ''); return d.length >= 7 ? d.slice(-9) : ''; };
const normMail = m => { const s = String(m || '').trim().toLowerCase(); return /@/.test(s) ? s : ''; };
const diasDesde = (f, hoy = Date.now()) => f ? Math.floor((hoy - new Date(f).getTime()) / 864e5) : null;

// ── RUC de facturación de una consignación: se lee de las NOTAS de la consignación
//    en el ERP. Se toma cualquier RUC de 11 dígitos (10/15/17/20…) escrito ahí.
//    · 1 RUC   → 'ok': ese es el RUC al que se factura lo vendido en esa consignación.
//    · 2+ RUC  → 'mixto': stock de varios RUC mezclado; el vendedor verifica con la guía.
//    · ninguno → 'sin_ruc': falta escribirlo; el vendedor verifica con la guía.
const RE_RUC = /(?<!\d)(10|15|17|20)\d{9}(?!\d)/g;
const rucsDeTexto = t => [...new Set(String(t || '').match(RE_RUC) || [])];
function estadoFactura(notas, hayCampo) {
  if (!hayCampo) return { estado: 'sin_campo', rucs: [], ruc: null };
  const rucs = rucsDeTexto(notas);
  if (rucs.length === 1) return { estado: 'ok', rucs, ruc: rucs[0] };
  return { estado: rucs.length ? 'mixto' : 'sin_ruc', rucs, ruc: null };
}

// ═══ Cálculo puro (sin base de datos) — se exporta para pruebas ═══
//  d = { usuarios, rucs, locs, partes, ventas, stock, ventasConsig, similares }
//    usuarios:     portal_users  [{id, username, customer_id, location_id, nombre_cliente, activo, ultimo_login, clave_inicial, created_at}]
//    rucs:         portal_user_rucs [{id, portal_user_id, customer_id, ruc, nombre, nota}]
//    locs:         locations consignment (activas e inactivas) [{id, name, is_active}]
//    partes:       parties de todos los customer_id involucrados
//    ventas:       [{customer_id, ultima, n12}]  última venta y nº ventas 12 meses
//    stock:        [{location_id, unidades, skus}]
//    ventasConsig: [{location_id, customer_id, n, ultima}] ventas que salieron de cada consignación
//                  (null si la consulta no está disponible en este ERP)
//    similares:    parties con mismo correo/teléfono que algún acceso [{id, ..., email, phone, ultima}]
function armarVista(d, hoy = Date.now()) {
  const parteDe = new Map((d.partes || []).map(p => [Number(p.id), p]));
  const locDe = new Map((d.locs || []).map(l => [Number(l.id), l]));
  const ventaDe = new Map((d.ventas || []).map(v => [Number(v.customer_id), v]));
  const extrasDe = new Map();
  (d.rucs || []).forEach(r => {
    const k = Number(r.portal_user_id);
    if (!extrasDe.has(k)) extrasDe.set(k, []);
    extrasDe.get(k).push(r);
  });

  // customer_id → acceso (principal o adicional)
  const accesoDeCliente = new Map();
  (d.usuarios || []).forEach(u => {
    if (u.customer_id != null) {
      const k = Number(u.customer_id);
      if (!accesoDeCliente.has(k)) accesoDeCliente.set(k, []);
      accesoDeCliente.get(k).push({ id: u.id, tipo: 'principal' });
    }
    (extrasDe.get(Number(u.id)) || []).forEach(r => {
      const k = Number(r.customer_id);
      if (!accesoDeCliente.has(k)) accesoDeCliente.set(k, []);
      accesoDeCliente.get(k).push({ id: u.id, tipo: 'adicional' });
    });
  });
  // Consignaciones de cada acceso: la principal (portal_users.location_id) + las adicionales
  const extrasLocDe = new Map();
  (d.consigExtra || []).forEach(x => {
    const k = Number(x.portal_user_id);
    if (!extrasLocDe.has(k)) extrasLocDe.set(k, []);
    extrasLocDe.get(k).push(Number(x.location_id));
  });
  const locsDe = u => [...new Set([u.location_id, ...(extrasLocDe.get(Number(u.id)) || [])].filter(Boolean).map(Number))];
  const factDe = id => (d.factura && d.factura[id]) || { estado: 'sin_campo', rucs: [], ruc: null };
  // location → accesos (solo activos cuentan como "asignada")
  const usuariosDeLoc = new Map();
  (d.usuarios || []).forEach(u => {
    locsDe(u).forEach(k => {
      if (!usuariosDeLoc.has(k)) usuariosDeLoc.set(k, []);
      usuariosDeLoc.get(k).push(u);
    });
  });
  const ventasDeLoc = new Map();
  (d.ventasConsig || []).forEach(v => {
    const k = Number(v.location_id);
    if (!ventasDeLoc.has(k)) ventasDeLoc.set(k, []);
    ventasDeLoc.get(k).push(v);
  });
  const stockDe = new Map((d.stock || []).map(s => [Number(s.location_id), s]));
  const resumenParte = id => {
    const p = parteDe.get(Number(id));
    const v = ventaDe.get(Number(id));
    return {
      customer_id: Number(id),
      nombre: p ? nombreParte(p) : '(no existe en el ERP)',
      ruc: p ? (p.document_number || '') : '',
      email: p ? (normMail(p.email) || '') : '',
      telefono: p ? (p.phone || '') : '',
      existe: !!p,
      ultima_venta: v ? v.ultima : null,
      ventas_12m: v ? Number(v.n12) || 0 : 0
    };
  };

  // ── Accesos ──
  const usuarios = (d.usuarios || []).map(u => {
    const principal = u.customer_id != null ? resumenParte(u.customer_id) : null;
    const extras = (extrasDe.get(Number(u.id)) || []).map(r => ({ ...resumenParte(r.customer_id), rel_id: r.id, nota: r.nota || '' }));
    const ids = new Set([principal && principal.customer_id, ...extras.map(e => e.customer_id)].filter(x => x != null));
    const misLocs = locsDe(u);
    const loc = u.location_id ? locDe.get(Number(u.location_id)) : null;
    // (mysql2 devuelve Date: se compara por tiempo, no por texto)
    const ultimas = [principal, ...extras].filter(Boolean).map(x => x.ultima_venta).filter(Boolean)
      .sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
    const ultimaVenta = ultimas.length ? ultimas[ultimas.length - 1] : null;
    const ventas12 = [principal, ...extras].filter(Boolean).reduce((a, x) => a + x.ventas_12m, 0);
    const email = (principal && principal.email) || (extras.find(e => e.email) || {}).email || '';
    const rucsGrupo = new Set([limpiarDoc(u.username), ...[principal, ...extras].filter(Boolean).map(x => limpiarDoc(x.ruc))].filter(Boolean));

    const alertas = [];
    const A = (cod, nivel, txt, extra) => alertas.push({ cod, nivel, txt, ...(extra || {}) });
    if (!principal || !principal.existe) A('empresa_no_existe', 'r', 'La empresa vinculada ya no existe en el ERP.');
    misLocs.forEach(lid => {
      const l = locDe.get(lid);
      if (!l) { A('consig_no_existe', 'r', 'Una de sus consignaciones ya no existe en el ERP.'); return; }
      if (!Number(l.is_active)) A('consig_inactiva', 'r', `Su consignación "${l.name}" está inactiva en el ERP.`);
      if (u.activo) {
        const otros = (usuariosDeLoc.get(lid) || []).filter(x => x.id !== u.id && x.activo);
        if (otros.length) A('consig_compartida', 'w', `"${l.name}" también la ve: ${otros.map(x => x.nombre_cliente).join(', ')}.`, { con: otros.map(x => x.id) });
      }
      // RUC de facturación (notas de la consignación)
      const f = factDe(lid);
      if (f.estado === 'ok' && !rucsGrupo.has(f.ruc))
        A('factura_ajena', 'r', `Las notas de "${l.name}" dicen facturar a ${f.ruc}${f.nombre ? ' (' + f.nombre + ')' : ''}, que no es un RUC de este cliente.`);
      else if (f.estado === 'mixto')
        A('factura_mixta', 'w', `"${l.name}" tiene varios RUC en notas (${f.rucs.join(', ')}): el vendedor verifica con la guía a cuál facturar.`);
      else if (f.estado === 'sin_ruc')
        A('factura_sin_ruc', 'w', `"${l.name}" no tiene RUC en notas: el vendedor verifica con la guía a cuál facturar.`);
    });
    if (principal && principal.existe) {
      if (limpiarDoc(principal.ruc) && limpiarDoc(principal.ruc) !== limpiarDoc(u.username) &&
          !extras.some(e => limpiarDoc(e.ruc) === limpiarDoc(u.username)))
        A('ruc_distinto', 'w', `Su usuario (${u.username}) no coincide con el RUC del ERP (${principal.ruc}).`);
      if (normNombre(principal.nombre) !== normNombre(u.nombre_cliente))
        A('nombre_distinto', 'i', `En el ERP se llama "${principal.nombre}".`, { nombre_erp: principal.nombre });
    }
    if (u.activo && !email) A('sin_correo', 'w', 'Sin correo en el ERP: el reporte de venta no le llega.');
    if (u.activo && Number(u.clave_inicial) === 1) A('clave_inicial', 'i', 'Sigue con la clave inicial (su RUC).');
    if (u.activo && ventas12 === 0 && (!ultimaVenta || diasDesde(ultimaVenta, hoy) > DIAS_SIN_VENTAS))
      A('sin_ventas', 'i', ultimaVenta ? `Sin ventas hace ${diasDesde(ultimaVenta, hoy)} días.` : 'Nunca tuvo ventas con este RUC.');
    // Ventas de su consignación facturadas a otro RUC → posible segundo RUC
    const otrosRuc = [];
    for (const lid of misLocs) {
      (ventasDeLoc.get(lid) || []).forEach(v => {
        if (ids.has(Number(v.customer_id))) return;
        if (otrosRuc.some(o => o.customer_id === Number(v.customer_id))) return;
        const r = resumenParte(v.customer_id);
        otrosRuc.push({ ...r, n: Number(v.n) || 0, ultima: v.ultima, origen: 'consignacion' });
      });
    }
    // Mismo correo / teléfono en otra empresa del ERP
    const mails = new Set([principal, ...extras].filter(Boolean).map(x => normMail(x.email)).filter(Boolean));
    const tels = new Set([principal, ...extras].filter(Boolean).map(x => normTel(x.telefono)).filter(Boolean));
    (d.similares || []).forEach(p => {
      if (ids.has(Number(p.id))) return;
      if (otrosRuc.some(o => o.customer_id === Number(p.id))) return;
      const porMail = normMail(p.email) && mails.has(normMail(p.email));
      const porTel = normTel(p.phone) && tels.has(normTel(p.phone));
      if (!porMail && !porTel) return;
      const r = resumenParte(p.id);
      r.nombre = nombreParte(p); r.ruc = p.document_number || ''; r.existe = true;
      otrosRuc.push({ ...r, ultima: p.ultima || null, origen: porMail ? 'correo' : 'telefono' });
    });
    // No sugerir RUCs que son genéricos o que ya tienen su propio acceso unido aquí
    const sugeridos = !Number(u.activo) ? [] : otrosRuc.filter(o => limpiarDoc(o.ruc).length >= 8 && !rucsGrupo.has(limpiarDoc(o.ruc)))
      .map(o => ({ ...o, acceso_propio: (accesoDeCliente.get(o.customer_id) || []).map(a => a.id) }));
    if (sugeridos.length) {
      const top = sugeridos[0];
      const porque = top.origen === 'consignacion' ? `${top.n} venta(s) de su consignación salieron a nombre de`
        : top.origen === 'correo' ? 'Mismo correo que' : 'Mismo teléfono que';
      A('otro_ruc', 'w', `${porque} ${top.nombre} (${top.ruc || 's/RUC'}). ¿Es la misma empresa?` +
        (sugeridos.length > 1 ? ` (+${sugeridos.length - 1} más)` : ''));
    }

    return {
      id: u.id, username: u.username, nombre_cliente: u.nombre_cliente, activo: !!Number(u.activo),
      customer_id: u.customer_id, location_id: u.location_id || null,
      consignacion: loc ? { id: loc.id, nombre: loc.name, activa: !!Number(loc.is_active) } : null,
      consignaciones: misLocs.map(lid => {
        const l = locDe.get(lid);
        return { id: lid, nombre: l ? l.name : '(no existe)', activa: !!(l && Number(l.is_active)), existe: !!l,
          principal: Number(u.location_id) === lid, factura: factDe(lid) };
      }),
      principal, extras, email, ultima_venta: ultimaVenta, ventas_12m: ventas12,
      ultimo_login: u.ultimo_login || null, clave_inicial: u.clave_inicial == null ? null : Number(u.clave_inicial),
      creado: u.created_at || null, alertas, sugeridos
    };
  });

  // ── Consignaciones (puntos de venta) ──
  const consignaciones = (d.locs || []).map(l => {
    const us = (usuariosDeLoc.get(Number(l.id)) || []);
    const activos = us.filter(x => Number(x.activo));
    const st = stockDe.get(Number(l.id)) || {};
    const compradores = (ventasDeLoc.get(Number(l.id)) || []).map(v => ({
      ...resumenParte(v.customer_id), n: Number(v.n) || 0, ultima: v.ultima,
      acceso: (accesoDeCliente.get(Number(v.customer_id)) || []).map(a => a.id)
    })).sort((a, b) => b.n - a.n);
    let estado = 'ok';
    if (!activos.length) estado = us.length ? 'solo_inactivos' : 'sin_empresa';
    else if (activos.length > 1) estado = 'compartida';
    return {
      id: l.id, nombre: l.name, activa: !!Number(l.is_active),
      accesos: us.map(x => ({ id: x.id, nombre: x.nombre_cliente, activo: !!Number(x.activo) })),
      unidades: Number(st.unidades) || 0, skus: Number(st.skus) || 0,
      compradores, estado, factura: factDe(Number(l.id))
    };
  });

  const n = (arr, fn) => arr.filter(fn).length;
  const resumen = {
    accesos: usuarios.length,
    activos: n(usuarios, u => u.activo),
    con_alertas: n(usuarios, u => u.activo && u.alertas.some(a => a.nivel !== 'i')),
    sin_correo: n(usuarios, u => u.activo && u.alertas.some(a => a.cod === 'sin_correo')),
    clave_inicial: n(usuarios, u => u.activo && u.alertas.some(a => a.cod === 'clave_inicial')),
    otro_ruc: n(usuarios, u => u.alertas.some(a => a.cod === 'otro_ruc')),
    varios_ruc: n(usuarios, u => u.extras.length > 0),
    consig_activas: n(consignaciones, c => c.activa),
    consig_sin_empresa: n(consignaciones, c => c.activa && c.estado !== 'ok' && c.estado !== 'compartida'),
    consig_sin_empresa_con_stock: n(consignaciones, c => c.activa && c.estado !== 'ok' && c.estado !== 'compartida' && c.unidades > 0),
    consig_compartidas: n(consignaciones, c => c.activa && c.estado === 'compartida'),
    ventas_consig_disponible: Array.isArray(d.ventasConsig),
    consig_sin_ruc_factura: n(consignaciones, c => c.activa && c.estado !== 'sin_empresa' && ['sin_ruc', 'mixto'].includes(c.factura.estado)),
    factura_ajena: n(usuarios, u => u.activo && u.alertas.some(a => a.cod === 'factura_ajena')),
    campo_notas: d.campoNotas || null
  };
  return { usuarios, consignaciones, resumen };
}

module.exports = function registrarClientesGestion({ app, authAdmin, requiereModulo, prodPool, portalPool, JWT_SECRET }) {
  const mGest = requiereModulo('clientes_gestion');

  // ─────────── Tablas ───────────
  let tablasListas = false;
  async function prepararTablas() {
    if (tablasListas) return;
    await portalPool.query(`
      CREATE TABLE IF NOT EXISTS portal_user_rucs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        portal_user_id INT NOT NULL,
        customer_id BIGINT NOT NULL,
        ruc VARCHAR(20) NOT NULL DEFAULT '',
        nombre VARCHAR(255) NOT NULL DEFAULT '',
        nota VARCHAR(255) NOT NULL DEFAULT '',
        creado_por VARCHAR(80) NOT NULL DEFAULT '',
        creado_en DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_customer (customer_id),
        KEY ix_user (portal_user_id),
        KEY ix_ruc (ruc)
      )`);
    // Consignaciones adicionales de un acceso (ej. el mismo local con una consignación
    // por RUC). La principal sigue en portal_users.location_id.
    await portalPool.query(`
      CREATE TABLE IF NOT EXISTS portal_user_consignaciones (
        id INT AUTO_INCREMENT PRIMARY KEY,
        portal_user_id INT NOT NULL,
        location_id BIGINT NOT NULL,
        creado_por VARCHAR(80) NOT NULL DEFAULT '',
        creado_en DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_user_loc (portal_user_id, location_id),
        KEY ix_loc (location_id)
      )`);
    let nueva = false;
    try { await portalPool.query(`ALTER TABLE portal_users ADD COLUMN ultimo_login DATETIME NULL`); } catch (e) { /* ya existe */ }
    try { await portalPool.query(`ALTER TABLE portal_users ADD COLUMN clave_inicial TINYINT NULL`); nueva = true; } catch (e) { /* ya existe */ }
    tablasListas = true;
    // Calcular en segundo plano quién sigue con la clave = RUC (solo filas sin dato)
    setTimeout(() => revisarClavesIniciales().catch(e => console.error('[gestion] claves', e.message)), nueva ? 2000 : 10000);
  }
  async function revisarClavesIniciales() {
    const [rows] = await portalPool.query(`SELECT id, username, password_hash FROM portal_users WHERE clave_inicial IS NULL LIMIT 500`);
    for (const r of rows) {
      let ini = 0;
      try { ini = (await bcrypt.compare(String(r.username), String(r.password_hash || ''))) ? 1 : 0; } catch (e) { ini = 0; }
      await portalPool.query(`UPDATE portal_users SET clave_inicial=? WHERE id=?`, [ini, r.id]);
    }
    if (rows.length) console.log(`[gestion] clave inicial revisada en ${rows.length} accesos`);
  }

  // ─────────── RUC de facturación (notas de la consignación en el ERP) ───────────
  // El nombre de la columna de notas se detecta solo (o se fija con LOCATION_NOTAS_COL).
  let _colNotas;
  async function colNotas() {
    if (_colNotas !== undefined) return _colNotas;
    try {
      const [cols] = await prodPool.query(`SHOW COLUMNS FROM locations`);
      const names = cols.map(c => String(c.Field || c.field || ''));
      const pedido = (process.env.LOCATION_NOTAS_COL || '').trim();
      _colNotas = (pedido && names.includes(pedido)) ? pedido
        : (['notes', 'note', 'notas', 'nota', 'observations', 'observaciones', 'comments', 'description', 'descripcion']
            .find(c => names.map(n => n.toLowerCase()).includes(c)) || null);
      if (_colNotas) _colNotas = names.find(n => n.toLowerCase() === _colNotas.toLowerCase());
      console.log(`[gestion] RUC de facturación: columna de notas de locations = ${_colNotas || '(no hay)'}`);
    } catch (e) { _colNotas = null; }
    return _colNotas;
  }
  const cacheFact = new Map(); // location_id → {at, v}
  // location_id[] → { [id]: { estado, rucs, ruc, nombre, customer_id, notas } }
  async function facturacionDe(locIds) {
    const ids = [...new Set((locIds || []).filter(Boolean).map(Number))];
    const out = {}; const faltan = [];
    ids.forEach(id => { const c = cacheFact.get(id); if (c && Date.now() - c.at < 60000) out[id] = c.v; else faltan.push(id); });
    if (!faltan.length) return out;
    const col = await colNotas();
    let rows = [];
    if (col) [rows] = await prodPool.query(`SELECT id, \`${col}\` AS notas FROM locations WHERE id IN (?)`, [faltan]);
    const notasDe = new Map(rows.map(r => [Number(r.id), r.notas || '']));
    const est = {}; const todos = new Set();
    faltan.forEach(id => { est[id] = { ...estadoFactura(notasDe.get(id), !!col), notas: notasDe.get(id) || '' }; est[id].rucs.forEach(r => todos.add(r)); });
    let partes = [];
    if (todos.size) [partes] = await prodPool.query(
      `SELECT id, is_company, business_name, first_name, last_name, document_number FROM parties WHERE TRIM(document_number) IN (?)`, [[...todos]]);
    const parteDeRuc = new Map();
    partes.forEach(p => { const k = limpiarDoc(p.document_number); if (!parteDeRuc.has(k)) parteDeRuc.set(k, p); });
    faltan.forEach(id => {
      const e = est[id];
      e.detalle = e.rucs.map(r => ({ ruc: r, nombre: parteDeRuc.has(r) ? nombreParte(parteDeRuc.get(r)) : null }));
      const p = e.ruc ? parteDeRuc.get(e.ruc) : null;
      e.nombre = p ? nombreParte(p) : null;
      e.customer_id = p ? p.id : null;
      e.existe = e.estado !== 'ok' || !!p;
      cacheFact.set(id, { at: Date.now(), v: e });
      out[id] = e;
    });
    return out;
  }

  // ─────────── Grupos de RUC (los usa el portal y Clientes BI) ───────────
  const cacheGrupo = new Map();
  let cacheAlias = null, cacheAliasAt = 0;
  function invalidar(portalUserId) {
    if (portalUserId == null) cacheGrupo.clear(); else cacheGrupo.delete(Number(portalUserId));
    cacheAlias = null;
  }
  // Estado actual de un acceso: activo, consignación y todos sus customer_id.
  // Se lee de la base (con caché corta) para que un cambio en Gestión se vea sin
  // que el cliente vuelva a entrar, y para cortar el acceso si se desactiva.
  async function grupoDe(portalUserId) {
    const k = Number(portalUserId);
    const c = cacheGrupo.get(k);
    if (c && Date.now() - c.at < TTL_GRUPO) return c.v;
    await prepararTablas();
    const [[u]] = await portalPool.query(`SELECT id, username, nombre_cliente, customer_id, location_id, activo FROM portal_users WHERE id=? LIMIT 1`, [k]);
    if (!u) { const v = null; cacheGrupo.set(k, { at: Date.now(), v }); return v; }
    const [ex] = await portalPool.query(`SELECT customer_id FROM portal_user_rucs WHERE portal_user_id=?`, [k]);
    const [exl] = await portalPool.query(`SELECT location_id FROM portal_user_consignaciones WHERE portal_user_id=? ORDER BY id`, [k]);
    const locs = [...new Set([u.location_id, ...exl.map(x => x.location_id)].filter(Boolean).map(Number))];
    const ids = [...new Set([u.customer_id, ...ex.map(x => x.customer_id)].filter(x => x != null).map(Number))];
    const v = { activo: !!Number(u.activo), location_id: locs[0] || null, locs, customer_id: u.customer_id, ids, nombre: u.nombre_cliente, ruc: u.username };
    cacheGrupo.set(k, { at: Date.now(), v });
    return v;
  }
  // Acceso que tiene este RUC como adicional (para entrar con cualquiera de sus RUC)
  async function usuarioPorRucAdicional(ruc) {
    await prepararTablas();
    const doc = limpiarDoc(ruc);
    if (doc.length < 8) return null;
    const [rows] = await portalPool.query(
      `SELECT u.* FROM portal_user_rucs r JOIN portal_users u ON u.id=r.portal_user_id
       WHERE r.ruc=? AND u.activo=1 LIMIT 1`, [doc]);
    return rows[0] || null;
  }
  // customer_id adicional → customer_id principal (para unir clientes en BI)
  async function mapaAlias() {
    if (cacheAlias && Date.now() - cacheAliasAt < TTL_ALIAS) return cacheAlias;
    const m = new Map();
    try {
      await prepararTablas();
      const [rows] = await portalPool.query(
        `SELECT r.customer_id AS alias, u.customer_id AS principal FROM portal_user_rucs r
         JOIN portal_users u ON u.id=r.portal_user_id WHERE u.customer_id IS NOT NULL`);
      rows.forEach(r => { m.set(Number(r.alias), Number(r.principal)); m.set(Number(r.principal), Number(r.principal)); });
    } catch (e) { console.error('[gestion] mapaAlias', e.message); }
    cacheAlias = m; cacheAliasAt = Date.now();
    return m;
  }

  // ─────────── Lecturas del ERP ───────────
  async function leerPartes(ids) {
    if (!ids.length) return [];
    const [rows] = await prodPool.query(
      `SELECT id, is_company, business_name, first_name, last_name, document_number, email, phone
       FROM parties WHERE id IN (?)`, [ids]);
    return rows;
  }
  async function leerVentas(ids) {
    if (!ids.length) return [];
    const [rows] = await prodPool.query(
      `SELECT customer_id, MAX(created_at) AS ultima,
         SUM(created_at >= DATE_SUB(NOW(), INTERVAL 12 MONTH)) AS n12
       FROM sales WHERE customer_id IN (?) AND deleted_at IS NULL AND status <> 'cancelled'
       GROUP BY customer_id`, [ids]);
    return rows;
  }
  // Ventas que salieron de cada consignación, agrupadas por cliente facturado.
  // El vínculo movimiento→venta depende del ERP (reference_type puede ser la venta
  // o el ítem); si la consulta falla, la función devuelve null y la vista lo indica.
  async function leerVentasConsig(locIds) {
    if (!locIds.length) return [];
    try {
      const [rows] = await prodPool.query(`
        SELECT sm.location_from_id AS location_id, s.customer_id, COUNT(DISTINCT s.id) AS n, MAX(s.created_at) AS ultima
        FROM stock_movements sm
        LEFT JOIN sale_items si ON sm.reference_type LIKE '%item%' AND si.id = sm.reference_id
        JOIN sales s ON s.id = COALESCE(si.sale_id,
             CASE WHEN sm.reference_type NOT LIKE '%item%' THEN sm.reference_id END)
        WHERE sm.type = 'sale' AND sm.location_from_id IN (?)
          AND sm.movement_date >= DATE_SUB(NOW(), INTERVAL ${DIAS_VENTAS_CONSIG} DAY)
          AND s.deleted_at IS NULL AND s.status <> 'cancelled' AND s.customer_id IS NOT NULL
          -- control: la venta debe contener ese producto (descarta un cruce equivocado)
          AND EXISTS (SELECT 1 FROM sale_items x WHERE x.sale_id = s.id AND x.product_variation_id = sm.product_variation_id)
        GROUP BY sm.location_from_id, s.customer_id`, [locIds]);
      return rows;
    } catch (e) {
      console.error('[gestion] ventas por consignación no disponible:', e.message);
      return null;
    }
  }
  async function leerSimilares(partes, excluir) {
    const mails = [...new Set(partes.map(p => normMail(p.email)).filter(Boolean))];
    const tels = [...new Set(partes.map(p => normTel(p.phone)).filter(Boolean))];
    if (!mails.length && !tels.length) return [];
    const conds = [], params = [];
    if (mails.length) { conds.push('LOWER(TRIM(p.email)) IN (?)'); params.push(mails); }
    if (tels.length) { conds.push(`RIGHT(REGEXP_REPLACE(p.phone, '[^0-9]', ''), 9) IN (?)`); params.push(tels); }
    try {
      const [rows] = await prodPool.query(`
        SELECT p.id, p.is_company, p.business_name, p.first_name, p.last_name, p.document_number, p.email, p.phone,
          (SELECT MAX(s.created_at) FROM sales s WHERE s.customer_id=p.id AND s.deleted_at IS NULL) AS ultima
        FROM parties p WHERE (${conds.join(' OR ')}) ${excluir.length ? 'AND p.id NOT IN (?)' : ''} LIMIT 300`,
        excluir.length ? [...params, excluir] : params);
      return rows;
    } catch (e) {
      // MySQL < 8 no tiene REGEXP_REPLACE: reintentar solo por correo
      if (!mails.length) return [];
      try {
        const [rows] = await prodPool.query(`
          SELECT p.id, p.is_company, p.business_name, p.first_name, p.last_name, p.document_number, p.email, p.phone,
            (SELECT MAX(s.created_at) FROM sales s WHERE s.customer_id=p.id AND s.deleted_at IS NULL) AS ultima
          FROM parties p WHERE LOWER(TRIM(p.email)) IN (?) ${excluir.length ? 'AND p.id NOT IN (?)' : ''} LIMIT 300`,
          excluir.length ? [mails, excluir] : [mails]);
        return rows;
      } catch (e2) { return []; }
    }
  }

  // ─────────── Vista completa ───────────
  app.get('/api/clientes-gestion', authAdmin, mGest, async (req, res) => {
    try {
      await prepararTablas();
      const [[usuarios], [rucs], [locs], [consigExtra]] = await Promise.all([
        portalPool.query(`SELECT id, username, customer_id, location_id, nombre_cliente, activo, created_at, ultimo_login, clave_inicial
                          FROM portal_users ORDER BY nombre_cliente`),
        portalPool.query(`SELECT id, portal_user_id, customer_id, ruc, nombre, nota FROM portal_user_rucs`),
        prodPool.query(`SELECT id, name, is_active FROM locations WHERE type='consignment' ORDER BY name`),
        portalPool.query(`SELECT portal_user_id, location_id FROM portal_user_consignaciones`)
      ]);
      // Consignaciones inactivas: solo las que alguien tiene asignadas (para avisar)
      const asignadas = new Set([...usuarios.map(u => Number(u.location_id)), ...consigExtra.map(x => Number(x.location_id))].filter(Boolean));
      const locsVista = locs.filter(l => Number(l.is_active) || asignadas.has(Number(l.id)));
      const locIds = locsVista.map(l => l.id);
      const [ventasConsig, [stock], factura] = await Promise.all([
        leerVentasConsig(locIds),
        locIds.length ? prodPool.query(
          `SELECT location_id, SUM(quantity) AS unidades, COUNT(*) AS skus FROM location_stocks
           WHERE location_id IN (?) AND quantity > 0 GROUP BY location_id`, [locIds]) : [[]],
        facturacionDe(locIds).catch(e => { console.error('[gestion] facturación', e.message); return {}; })
      ]);
      const ids = [...new Set([
        ...usuarios.map(u => u.customer_id), ...rucs.map(r => r.customer_id),
        ...(ventasConsig || []).map(v => v.customer_id)
      ].filter(x => x != null).map(Number))];
      const [partes, ventas] = await Promise.all([leerPartes(ids), leerVentas(ids)]);
      const idsAccesos = new Set([...usuarios.map(u => Number(u.customer_id)), ...rucs.map(r => Number(r.customer_id))]);
      const partesAccesos = partes.filter(p => idsAccesos.has(Number(p.id)));
      // Otras empresas del ERP con el mismo correo/teléfono + los propios accesos entre sí
      // (dos accesos con el mismo correo suelen ser la misma empresa con dos RUC)
      const similares = [...await leerSimilares(partesAccesos, [...idsAccesos]),
        ...partesAccesos.map(p => ({ ...p, ultima: (ventas.find(v => Number(v.customer_id) === Number(p.id)) || {}).ultima || null }))];
      const vista = armarVista({ usuarios, rucs, locs: locsVista, partes, ventas, stock, ventasConsig, similares,
        consigExtra, factura, campoNotas: await colNotas() });
      vista.generado = new Date().toISOString();
      res.json(vista);
    } catch (e) {
      console.error('[gestion] vista', e);
      res.status(500).json({ error: 'No se pudo armar la gestión de clientes: ' + e.message });
    }
  });

  // Empresas del ERP para elegir (empresas + personas con RUC 10/15/17/20)
  app.get('/api/clientes-gestion/empresas', authAdmin, mGest, async (req, res) => {
    try {
      const [rows] = await prodPool.query(`
        SELECT p.id AS customer_id, p.is_company, p.business_name, p.first_name, p.last_name, p.document_number,
          (p.email IS NOT NULL AND TRIM(p.email) <> '') AS tiene_correo,
          (SELECT MAX(s.created_at) FROM sales s WHERE s.customer_id=p.id AND s.deleted_at IS NULL) AS ultima_venta
        FROM parties p
        WHERE (p.is_company = 1 AND COALESCE(TRIM(p.business_name),'') <> '')
           OR (CHAR_LENGTH(TRIM(p.document_number)) = 11 AND TRIM(p.document_number) REGEXP '^(10|15|17|20)')`);
      res.json(rows.map(r => ({
        customer_id: r.customer_id, nombre: nombreParte(r), ruc: (r.document_number || '').trim(),
        tipo: r.is_company ? 'empresa' : 'persona', tiene_correo: !!Number(r.tiene_correo), ultima_venta: r.ultima_venta
      })).filter(r => r.nombre).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es')));
    } catch (e) { res.status(500).json({ error: 'Error al leer empresas del ERP: ' + e.message }); }
  });

  async function parteERP(customerId) {
    const [[p]] = await prodPool.query(
      `SELECT id, is_company, business_name, first_name, last_name, document_number, email FROM parties WHERE id=? LIMIT 1`, [customerId]);
    return p || null;
  }
  async function locValida(locationId) {
    if (!locationId) return true;
    const [[l]] = await prodPool.query(`SELECT id FROM locations WHERE id=? AND type='consignment' LIMIT 1`, [locationId]);
    return !!l;
  }
  // ¿Este customer_id ya pertenece a otro acceso (principal o adicional)?
  async function duenoDe(customerId, salvoUser) {
    const [a] = await portalPool.query(
      `SELECT id, username, nombre_cliente, activo, 'principal' AS tipo FROM portal_users WHERE customer_id=? ${salvoUser ? 'AND id<>?' : ''}`,
      salvoUser ? [customerId, salvoUser] : [customerId]);
    const [b] = await portalPool.query(
      `SELECT u.id, u.username, u.nombre_cliente, u.activo, 'adicional' AS tipo FROM portal_user_rucs r JOIN portal_users u ON u.id=r.portal_user_id
       WHERE r.customer_id=? ${salvoUser ? 'AND u.id<>?' : ''}`, salvoUser ? [customerId, salvoUser] : [customerId]);
    return [...a, ...b];
  }

  // ─────────── Crear acceso ───────────
  // Ya NO pisa un acceso existente: antes, "crear" un RUC que ya tenía acceso le
  // borraba la consignación (location_id pasaba a NULL) y decía "clave = RUC"
  // aunque la clave no se cambiaba.
  app.post('/api/clientes-gestion/crear', authAdmin, mGest, async (req, res) => {
    const { customer_id, location_id } = req.body || {};
    if (!customer_id) return res.status(400).json({ error: 'Elige una empresa del ERP' });
    try {
      await prepararTablas();
      const p = await parteERP(customer_id);
      if (!p) return res.status(404).json({ error: 'La empresa no existe en el ERP' });
      const ruc = limpiarDoc(p.document_number);
      if (ruc.length < 8) return res.status(400).json({ error: 'Esa empresa no tiene RUC/DNI en el ERP. Regístralo primero.' });
      if (!(await locValida(location_id))) return res.status(400).json({ error: 'Consignación no válida' });
      const [ya] = await portalPool.query(`SELECT id, nombre_cliente FROM portal_users WHERE username=? LIMIT 1`, [ruc]);
      if (ya.length) return res.status(409).json({ error: `Ese RUC ya tiene acceso (${ya[0].nombre_cliente}).` });
      const otros = await duenoDe(customer_id);
      if (otros.length) return res.status(409).json({ error: `Esa empresa ya está dentro del acceso de ${otros[0].nombre_cliente} (${otros[0].tipo}).` });
      const [rr] = await portalPool.query(`SELECT u.nombre_cliente FROM portal_user_rucs r JOIN portal_users u ON u.id=r.portal_user_id WHERE r.ruc=? LIMIT 1`, [ruc]);
      if (rr.length) return res.status(409).json({ error: `Ese RUC ya es un RUC adicional de ${rr[0].nombre_cliente}.` });
      const hash = await bcrypt.hash(ruc, 10);
      const [r] = await portalPool.query(
        `INSERT INTO portal_users (username, password_hash, customer_id, location_id, nombre_cliente, activo, clave_inicial)
         VALUES (?,?,?,?,?,1,1)`, [ruc, hash, customer_id, location_id || null, nombreParte(p)]);
      res.json({ ok: true, id: r.insertId, usuario: ruc, password_inicial: ruc, sin_correo: !normMail(p.email) });
    } catch (e) { res.status(500).json({ error: 'Error al crear: ' + e.message }); }
  });

  // Crear todos de golpe: empresas con ventas en los últimos N meses (def. 12).
  // Salta las que ya están en un acceso (principal o adicional) y las de RUC repetido.
  app.post('/api/clientes-gestion/crear-todos', authAdmin, mGest, async (req, res) => {
    const meses = Math.max(1, Math.min(120, parseInt((req.body || {}).meses, 10) || 12));
    const simular = !!(req.body || {}).simular;
    try {
      await prepararTablas();
      const [clientes] = await prodPool.query(`
        SELECT p.id AS customer_id, p.is_company, p.business_name, p.first_name, p.last_name, p.document_number, MAX(s.created_at) AS ultima
        FROM parties p JOIN sales s ON s.customer_id=p.id AND s.deleted_at IS NULL AND s.status <> 'cancelled'
        WHERE p.is_company=1 AND p.document_number IS NOT NULL AND TRIM(p.document_number) <> ''
          AND s.created_at >= DATE_SUB(NOW(), INTERVAL ? MONTH)
        GROUP BY p.id ORDER BY ultima DESC`, [meses]);
      const [us] = await portalPool.query(`SELECT username, customer_id FROM portal_users`);
      const [ex] = await portalPool.query(`SELECT ruc, customer_id FROM portal_user_rucs`);
      const rucsTomados = new Set([...us.map(u => limpiarDoc(u.username)), ...ex.map(x => limpiarDoc(x.ruc))]);
      const idsTomados = new Set([...us.map(u => Number(u.customer_id)), ...ex.map(x => Number(x.customer_id))]);
      const crear = [], saltados = [], repetidos = [];
      for (const c of clientes) {
        const ruc = limpiarDoc(c.document_number);
        if (ruc.length < 8) { saltados.push({ nombre: nombreParte(c), motivo: 'RUC inválido' }); continue; }
        if (idsTomados.has(Number(c.customer_id))) { saltados.push({ nombre: nombreParte(c), motivo: 'ya tiene acceso' }); continue; }
        if (rucsTomados.has(ruc)) { repetidos.push({ nombre: nombreParte(c), ruc, motivo: 'RUC repetido en otra ficha del ERP' }); continue; }
        rucsTomados.add(ruc); idsTomados.add(Number(c.customer_id));
        crear.push({ ruc, customer_id: c.customer_id, nombre: nombreParte(c) });
      }
      if (simular) return res.json({ ok: true, simulado: true, meses, a_crear: crear, saltados: saltados.length, repetidos });
      let creados = 0; const errores = [];
      for (const c of crear) {
        try {
          await portalPool.query(
            `INSERT INTO portal_users (username, password_hash, customer_id, location_id, nombre_cliente, activo, clave_inicial)
             VALUES (?,?,?,NULL,?,1,1)`, [c.ruc, await bcrypt.hash(c.ruc, 10), c.customer_id, c.nombre]);
          creados++;
        } catch (e) { errores.push({ nombre: c.nombre, error: e.code === 'ER_DUP_ENTRY' ? 'ya existía' : e.message }); }
      }
      invalidar();
      res.json({ ok: true, meses, creados, saltados: saltados.length, repetidos, errores, total: clientes.length });
    } catch (e) { res.status(500).json({ error: 'Error: ' + e.message }); }
  });

  // ─────────── Editar acceso ───────────
  app.post('/api/clientes-gestion/vincular', authAdmin, mGest, async (req, res) => {
    const { portal_user_id, location_id } = req.body || {};
    if (!portal_user_id) return res.status(400).json({ error: 'Falta el acceso' });
    try {
      if (!(await locValida(location_id))) return res.status(400).json({ error: 'Consignación no válida' });
      const [r] = await portalPool.query('UPDATE portal_users SET location_id=? WHERE id=?', [location_id || null, portal_user_id]);
      if (!r.affectedRows) return res.status(404).json({ error: 'Acceso no encontrado' });
      let compartida = [];
      if (location_id) {
        const [o] = await portalPool.query('SELECT nombre_cliente FROM portal_users WHERE location_id=? AND id<>? AND activo=1', [location_id, portal_user_id]);
        compartida = o.map(x => x.nombre_cliente);
      }
      invalidar(portal_user_id);
      res.json({ ok: true, compartida });
    } catch (e) { res.status(500).json({ error: 'Error al vincular' }); }
  });

  // Consignaciones adicionales (ej. mismo local, una consignación por RUC)
  app.post('/api/clientes-gestion/consignaciones/agregar', authAdmin, mGest, async (req, res) => {
    const { portal_user_id, location_id } = req.body || {};
    if (!portal_user_id || !location_id) return res.status(400).json({ error: 'Faltan datos' });
    try {
      await prepararTablas();
      if (!(await locValida(location_id))) return res.status(400).json({ error: 'Consignación no válida' });
      const [[u]] = await portalPool.query('SELECT id, location_id FROM portal_users WHERE id=?', [portal_user_id]);
      if (!u) return res.status(404).json({ error: 'Acceso no encontrado' });
      if (Number(u.location_id) === Number(location_id)) return res.status(400).json({ error: 'Ya es su consignación principal' });
      if (!u.location_id) await portalPool.query('UPDATE portal_users SET location_id=? WHERE id=?', [location_id, portal_user_id]);
      else await portalPool.query(`INSERT IGNORE INTO portal_user_consignaciones (portal_user_id, location_id, creado_por) VALUES (?,?,?)`,
        [portal_user_id, location_id, (req.admin && req.admin.usuario) || '']);
      invalidar(portal_user_id);
      const f = (await facturacionDe([location_id]))[Number(location_id)];
      res.json({ ok: true, factura: f });
    } catch (e) { res.status(500).json({ error: 'Error: ' + e.message }); }
  });
  app.post('/api/clientes-gestion/consignaciones/quitar', authAdmin, mGest, async (req, res) => {
    const { portal_user_id, location_id } = req.body || {};
    try {
      await prepararTablas();
      const [[u]] = await portalPool.query('SELECT id, location_id FROM portal_users WHERE id=?', [portal_user_id]);
      if (!u) return res.status(404).json({ error: 'Acceso no encontrado' });
      if (Number(u.location_id) === Number(location_id)) {
        // Quitar la principal: sube la primera adicional (si hay)
        const [[sig]] = await portalPool.query('SELECT id, location_id FROM portal_user_consignaciones WHERE portal_user_id=? ORDER BY id LIMIT 1', [portal_user_id]);
        await portalPool.query('UPDATE portal_users SET location_id=? WHERE id=?', [sig ? sig.location_id : null, portal_user_id]);
        if (sig) await portalPool.query('DELETE FROM portal_user_consignaciones WHERE id=?', [sig.id]);
      } else {
        await portalPool.query('DELETE FROM portal_user_consignaciones WHERE portal_user_id=? AND location_id=?', [portal_user_id, location_id]);
      }
      invalidar(portal_user_id);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'Error: ' + e.message }); }
  });

  app.post('/api/clientes-gestion/activar', authAdmin, mGest, async (req, res) => {
    const { portal_user_id, activo } = req.body || {};
    try {
      await portalPool.query('UPDATE portal_users SET activo=? WHERE id=?', [activo ? 1 : 0, portal_user_id]);
      invalidar(portal_user_id);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'Error al actualizar' }); }
  });

  app.post('/api/clientes-gestion/reset-password', authAdmin, mGest, async (req, res) => {
    const { portal_user_id } = req.body || {};
    try {
      await prepararTablas();
      const [rows] = await portalPool.query('SELECT username FROM portal_users WHERE id=? LIMIT 1', [portal_user_id]);
      if (!rows.length) return res.status(404).json({ error: 'Acceso no encontrado' });
      const hash = await bcrypt.hash(rows[0].username, 10);
      await portalPool.query('UPDATE portal_users SET password_hash=?, clave_inicial=1 WHERE id=?', [hash, portal_user_id]);
      res.json({ ok: true, password: rows[0].username });
    } catch (e) { res.status(500).json({ error: 'Error al resetear' }); }
  });

  // Copiar el nombre del ERP al acceso (cuando el ERP cambió la razón social)
  app.post('/api/clientes-gestion/sincronizar-nombre', authAdmin, mGest, async (req, res) => {
    const { portal_user_id } = req.body || {};
    try {
      const [[u]] = await portalPool.query('SELECT customer_id FROM portal_users WHERE id=? LIMIT 1', [portal_user_id]);
      if (!u) return res.status(404).json({ error: 'Acceso no encontrado' });
      const p = await parteERP(u.customer_id);
      if (!p) return res.status(404).json({ error: 'La empresa ya no existe en el ERP' });
      await portalPool.query('UPDATE portal_users SET nombre_cliente=? WHERE id=?', [nombreParte(p), portal_user_id]);
      res.json({ ok: true, nombre: nombreParte(p) });
    } catch (e) { res.status(500).json({ error: 'Error: ' + e.message }); }
  });

  // Ver el portal como un cliente (soporte): token de cliente sin su contraseña.
  app.post('/api/clientes-gestion/ver-como-cliente', authAdmin, mGest, async (req, res) => {
    const { portal_user_id } = req.body || {};
    if (!portal_user_id) return res.status(400).json({ error: 'Falta el acceso' });
    try {
      const [rows] = await portalPool.query('SELECT * FROM portal_users WHERE id=? AND activo=1 LIMIT 1', [portal_user_id]);
      if (!rows.length) return res.status(404).json({ error: 'Cliente no encontrado o inactivo' });
      const u = rows[0];
      const token = jwt.sign({
        rol: 'cliente', portal_user_id: u.id, customer_id: u.customer_id,
        location_id: u.location_id, nombre: u.nombre_cliente, ruc: u.username,
        via_admin: req.admin ? req.admin.usuario : true
      }, JWT_SECRET, { expiresIn: '1h' });
      res.json({ token, cliente: { nombre: u.nombre_cliente, ruc: u.username } });
    } catch (e) { res.status(500).json({ error: 'Error del servidor' }); }
  });

  // ─────────── Varios RUC por empresa ───────────
  // Agregar un RUC del ERP al acceso. Si ese RUC ya tiene su propio acceso, se
  // devuelve 409 con el conflicto; con unir=true se desactiva ese otro acceso (y si
  // este no tenía consignación, hereda la del otro).
  app.post('/api/clientes-gestion/rucs/agregar', authAdmin, mGest, async (req, res) => {
    const { portal_user_id, customer_id, nota, unir } = req.body || {};
    if (!portal_user_id || !customer_id) return res.status(400).json({ error: 'Faltan datos' });
    try {
      await prepararTablas();
      const [[u]] = await portalPool.query('SELECT id, customer_id, location_id FROM portal_users WHERE id=? LIMIT 1', [portal_user_id]);
      if (!u) return res.status(404).json({ error: 'Acceso no encontrado' });
      if (Number(u.customer_id) === Number(customer_id)) return res.status(400).json({ error: 'Ese ya es su RUC principal' });
      const p = await parteERP(customer_id);
      if (!p) return res.status(404).json({ error: 'La empresa no existe en el ERP' });
      const ruc = limpiarDoc(p.document_number);
      const otros = await duenoDe(customer_id, portal_user_id);
      const [porUser] = ruc ? await portalPool.query(
        `SELECT id, username, nombre_cliente, activo, location_id, 'principal' AS tipo FROM portal_users WHERE username=? AND id<>?`, [ruc, portal_user_id]) : [[]];
      const conflictos = [...otros, ...porUser.filter(x => !otros.some(o => o.id === x.id))];
      const adicionalesAjenos = conflictos.filter(c => c.tipo === 'adicional');
      if (adicionalesAjenos.length) return res.status(409).json({ error: `Ese RUC ya es adicional de ${adicionalesAjenos[0].nombre_cliente}. Quítalo de allí primero.` });
      if (conflictos.length && !unir) return res.status(409).json({ conflicto: conflictos, error: `Ese RUC tiene su propio acceso (${conflictos[0].nombre_cliente}).` });
      await portalPool.query(
        `INSERT INTO portal_user_rucs (portal_user_id, customer_id, ruc, nombre, nota, creado_por) VALUES (?,?,?,?,?,?)`,
        [portal_user_id, customer_id, ruc, nombreParte(p), String(nota || '').slice(0, 255), (req.admin && req.admin.usuario) || '']);
      let heredo = null;
      for (const c of conflictos) {
        const [[o]] = await portalPool.query('SELECT id, location_id FROM portal_users WHERE id=?', [c.id]);
        if (!u.location_id && !heredo && o && o.location_id) {
          heredo = o.location_id;
          await portalPool.query('UPDATE portal_users SET location_id=? WHERE id=?', [o.location_id, portal_user_id]);
        }
        // Se desactiva y se libera su usuario (queda "~id-RUC"), para que el RUC pueda
        // ser el usuario de entrada del acceso que lo absorbe. No se borra: queda el rastro.
        const [[dest]] = await portalPool.query('SELECT nombre_cliente FROM portal_users WHERE id=?', [portal_user_id]);
        await portalPool.query(
          `UPDATE portal_users SET activo=0, username=CONCAT('~', id, '-', username),
             nombre_cliente=LEFT(CONCAT(nombre_cliente, ' (unido a ', ?, ')'), 200)
           WHERE id=? AND username NOT LIKE '~%'`, [dest ? dest.nombre_cliente : '#' + portal_user_id, c.id]);
        invalidar(c.id);
      }
      invalidar(portal_user_id);
      res.json({ ok: true, ruc, nombre: nombreParte(p), desactivados: conflictos.map(c => c.nombre_cliente), heredo_consignacion: !!heredo });
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Ese RUC ya está agrupado en otro acceso' });
      res.status(500).json({ error: 'Error: ' + e.message });
    }
  });

  app.post('/api/clientes-gestion/rucs/quitar', authAdmin, mGest, async (req, res) => {
    const { id } = req.body || {};
    try {
      await prepararTablas();
      const [[r]] = await portalPool.query('SELECT portal_user_id FROM portal_user_rucs WHERE id=?', [id]);
      if (!r) return res.status(404).json({ error: 'No encontrado' });
      await portalPool.query('DELETE FROM portal_user_rucs WHERE id=?', [id]);
      invalidar(r.portal_user_id);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'Error: ' + e.message }); }
  });

  // Volver principal un RUC adicional (ej. Puntobike SAC se dio de baja y ahora
  // facturan como Frisancho Pereyra Sadith). El principal anterior queda como
  // adicional, así su historial sigue visible. Opcional: cambiar el usuario de
  // entrada al nuevo RUC (la clave no cambia; igual puede entrar con ambos).
  app.post('/api/clientes-gestion/rucs/hacer-principal', authAdmin, mGest, async (req, res) => {
    const { id, cambiar_usuario } = req.body || {};
    const conn = await portalPool.getConnection();
    try {
      await prepararTablas();
      const [[r]] = await conn.query('SELECT * FROM portal_user_rucs WHERE id=?', [id]);
      if (!r) { conn.release(); return res.status(404).json({ error: 'No encontrado' }); }
      const [[u]] = await conn.query('SELECT * FROM portal_users WHERE id=?', [r.portal_user_id]);
      const nuevo = await parteERP(r.customer_id);
      if (!nuevo) { conn.release(); return res.status(404).json({ error: 'Esa empresa ya no existe en el ERP' }); }
      const viejo = u.customer_id != null ? await parteERP(u.customer_id) : null;
      const rucNuevo = limpiarDoc(nuevo.document_number);
      let usuario = u.username;
      if (cambiar_usuario && rucNuevo.length >= 8 && rucNuevo !== u.username) {
        const [t] = await conn.query('SELECT id FROM portal_users WHERE username=? AND id<>?', [rucNuevo, u.id]);
        if (t.length) { conn.release(); return res.status(409).json({ error: 'El nuevo RUC ya es usuario de otro acceso; desactívalo o únelo primero.' }); }
        usuario = rucNuevo;
      }
      await conn.beginTransaction();
      if (u.customer_id != null) {
        await conn.query('UPDATE portal_user_rucs SET customer_id=?, ruc=?, nombre=?, nota=? WHERE id=?',
          [u.customer_id, viejo ? limpiarDoc(viejo.document_number) : limpiarDoc(u.username), viejo ? nombreParte(viejo) : u.nombre_cliente,
           'Anterior principal', id]);
      } else {
        await conn.query('DELETE FROM portal_user_rucs WHERE id=?', [id]);
      }
      await conn.query('UPDATE portal_users SET customer_id=?, nombre_cliente=?, username=? WHERE id=?',
        [r.customer_id, nombreParte(nuevo), usuario, u.id]);
      await conn.commit();
      conn.release();
      invalidar(u.id);
      res.json({ ok: true, nombre: nombreParte(nuevo), usuario });
    } catch (e) {
      try { await conn.rollback(); } catch (_) {}
      conn.release();
      res.status(500).json({ error: 'Error: ' + e.message });
    }
  });

  return { prepararTablas, grupoDe, usuarioPorRucAdicional, mapaAlias, invalidar, facturacionDe };
};

module.exports._test = { armarVista, normNombre, limpiarDoc, nombreParte, rucsDeTexto, estadoFactura };
