// ═══════════════════════════════════════════════════════════════════════════
//  MÓDULO: Seguimiento de envíos (trackings) + gestión de Backorders
//
//  Idea (lo pediste tú):
//   1) TÚ (maestro) subes una factura de proveedor. La IA (Gemini, misma clave
//      protegida que Importaciones) la lee y devuelve las líneas con su
//      traducción al ESPAÑOL. La factura NO se modifica: se muestra tal cual y
//      se le asigna manualmente un N° de TRACKING. Cada línea trae su SKU
//      sugerido con un INDICADOR DE CONFIANZA (exacto/alta/revisar/sin match),
//      igual que en Importaciones.
//   2) El envío queda con su tracking y sus ítems. Se marca cuáles de esos
//      ítems corresponden a productos en BACKORDER (los que un cliente ya pidió
//      y están esperando stock). Así el SUPERVISOR ve, con el tracking, qué está
//      llegando y con cuánta confianza, y cuáles cubren backorders.
//   3) GESTIÓN DE BACKORDERS: la lista de pedidos a la espera de stock se lee
//      del ERP (sale_items.is_backorder = 1, SOLO LECTURA) y se "fija" en el
//      portal para poder gestionarla: marcar cuáles YA compraste, escribir una
//      NOTA por ítem (por qué no lo has comprado / cuándo lo comprarás) y
//      organizarlos en GRUPOS con nombre. Cada grupo lleva info de la venta:
//      VTA, cliente, precio de venta y precio ya pagado.
//
//  Permisos:
//   · LEER  todo → cualquier admin con el módulo 'seguimiento' (incluye al
//     supervisor). El supervisor VE los envíos, trackings, confianza,
//     backorders y la info de venta de los grupos.
//   · ESCRIBIR (subir factura, IA, asignar tracking, gestionar backorders,
//     grupos) → SOLO el maestro. El supervisor no sube nada.
//
//  Almacenamiento:
//   · prodPool (ERP de Renzo) → SOLO LECTURA: catálogo y líneas de backorder.
//   · portalPool → tablas seg_* (envíos, backorders gestionados, grupos).
//   · La factura NO se guarda (ni el PDF): solo la tabla de líneas ya leída.
// ═══════════════════════════════════════════════════════════════════════════

module.exports = function registrarSeguimiento({
  app, authAdmin, requiereModulo, prodPool, portalPool
}) {

  const mSeg = requiereModulo('seguimiento'); // lectura: admin con el módulo (el maestro pasa)

  // Throttle de la sincronización con el ERP (lo más costoso). El botón
  // "Actualizar" fuerza; la sincronización automática al abrir respeta este límite.
  let _lastSyncSeg = 0;
  const SYNC_TTL_SEG = 3 * 60 * 1000;

  // Escritura: SOLO el maestro. El supervisor únicamente visualiza.
  function soloMaestroSeg(req, res, next) {
    if (!req.admin || !req.admin.maestro)
      return res.status(403).json({ error: 'Solo el administrador puede modificar el seguimiento.' });
    next();
  }

  // ── Preparar tablas del portal (se llama una vez al arrancar) ──────────────
  async function prepararTablas() {
    // Grupos de backorder (con info de la venta). Un grupo agrupa varios ítems.
    await portalPool.query(`
      CREATE TABLE IF NOT EXISTS seg_grupos (
        id             VARCHAR(40) PRIMARY KEY,
        nombre         VARCHAR(200) NOT NULL DEFAULT '',
        vta            VARCHAR(120) NOT NULL DEFAULT '',
        cliente        VARCHAR(255) NOT NULL DEFAULT '',
        precio_venta   DECIMAL(12,2) NULL,
        precio_pagado  DECIMAL(12,2) NULL,
        nota           TEXT,
        orden          INT NOT NULL DEFAULT 0,
        creado_en      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        actualizado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )`);

    // Ítems de backorder GESTIONADOS. Se "fijan" desde el ERP (origen='erp',
    // id = 'erp:'+sale_item_id) o se agregan a mano (origen='manual').
    await portalPool.query(`
      CREATE TABLE IF NOT EXISTS seg_bo_items (
        id             VARCHAR(60) PRIMARY KEY,
        grupo_id       VARCHAR(40) NULL,
        sku            VARCHAR(120) NOT NULL DEFAULT '',
        nombre         VARCHAR(255) NOT NULL DEFAULT '',
        cliente        VARCHAR(255) NOT NULL DEFAULT '',
        venta          VARCHAR(120) NOT NULL DEFAULT '',
        cantidad       INT NULL,
        fecha          DATE NULL,
        comprado       TINYINT(1) NOT NULL DEFAULT 0,
        nota           TEXT,
        orden          INT NOT NULL DEFAULT 0,
        origen         VARCHAR(10) NOT NULL DEFAULT 'erp',
        archivado      TINYINT(1) NOT NULL DEFAULT 0,
        envio_id       VARCHAR(40) NULL,
        tracking       VARCHAR(400) NOT NULL DEFAULT '',
        cubierto       INT NOT NULL DEFAULT 0,
        coberturas     JSON NULL,
        creado_en      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        actualizado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX (grupo_id), INDEX (sku), INDEX (comprado), INDEX (archivado), INDEX (envio_id)
      )`);
    // Por si la tabla ya existía sin estas columnas (vínculo/tracking/cantidades cubiertas).
    try { await portalPool.query(`ALTER TABLE seg_bo_items ADD COLUMN envio_id VARCHAR(40) NULL`); } catch (e) {}
    try { await portalPool.query(`ALTER TABLE seg_bo_items ADD COLUMN tracking VARCHAR(400) NOT NULL DEFAULT ''`); } catch (e) {}
    try { await portalPool.query(`ALTER TABLE seg_bo_items MODIFY tracking VARCHAR(400) NOT NULL DEFAULT ''`); } catch (e) {}
    try { await portalPool.query(`ALTER TABLE seg_bo_items ADD COLUMN cubierto INT NOT NULL DEFAULT 0`); } catch (e) {}
    try { await portalPool.query(`ALTER TABLE seg_bo_items ADD COLUMN coberturas JSON NULL`); } catch (e) {}

    // Envíos (trackings) con sus ítems leídos de la factura (tabla, no el PDF).
    await portalPool.query(`
      CREATE TABLE IF NOT EXISTS seg_envios (
        id             VARCHAR(40) PRIMARY KEY,
        tracking       VARCHAR(160) NOT NULL DEFAULT '',
        courier        VARCHAR(80)  NOT NULL DEFAULT '',
        proveedor      VARCHAR(255) NOT NULL DEFAULT '',
        n_factura      VARCHAR(160) NOT NULL DEFAULT '',
        estado         VARCHAR(20)  NOT NULL DEFAULT 'en_transito',
        fecha_estimada DATE NULL,
        nota           TEXT,
        items          JSON NOT NULL,
        creado_por     VARCHAR(120) NOT NULL DEFAULT '',
        archivado      TINYINT(1) NOT NULL DEFAULT 0,
        creado_en      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        actualizado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX (tracking), INDEX (estado)
      )`);
    // Por si la tabla ya existía sin la columna de archivado.
    try { await portalPool.query(`ALTER TABLE seg_envios ADD COLUMN archivado TINYINT(1) NOT NULL DEFAULT 0`); } catch (e) {}
    // ── Logística de 2 tramos + estado del courier (tramo 1 por API) ──────────
    try { await portalPool.query(`ALTER TABLE seg_envios ADD COLUMN hub VARCHAR(20) NOT NULL DEFAULT ''`); } catch (e) {}          // miami | madrid | espana | otro
    try { await portalPool.query(`ALTER TABLE seg_envios ADD COLUMN fase VARCHAR(20) NOT NULL DEFAULT 'transito'`); } catch (e) {} // transito | en_hub | embarcado | recibido
    try { await portalPool.query(`ALTER TABLE seg_envios ADD COLUMN fecha_salida DATE NULL`); } catch (e) {}                      // salida del hub hacia Perú
    try { await portalPool.query(`ALTER TABLE seg_envios ADD COLUMN eta DATE NULL`); } catch (e) {}                               // llegada estimada a Perú
    try { await portalPool.query(`ALTER TABLE seg_envios ADD COLUMN api_resumen VARCHAR(255) NOT NULL DEFAULT ''`); } catch (e) {}// resumen legible del courier
    try { await portalPool.query(`ALTER TABLE seg_envios ADD COLUMN api_estado VARCHAR(40) NOT NULL DEFAULT ''`); } catch (e) {}  // estado crudo del courier
    try { await portalPool.query(`ALTER TABLE seg_envios ADD COLUMN api_at DATETIME NULL`); } catch (e) {}                        // última lectura por API

    // Token de seguimiento público por CLIENTE (link que se comparte al cliente).
    await portalPool.query(`
      CREATE TABLE IF NOT EXISTS seg_cliente_token (
        token     VARCHAR(40) PRIMARY KEY,
        cliente   VARCHAR(255) NOT NULL,
        creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX (cliente)
      )`);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  const asJson = (v, fb) => {
    if (v == null) return fb;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch (e) { return fb; }
  };
  const s = (v) => (v == null ? '' : String(v));
  const numOrNull = (v) => (v === '' || v == null || isNaN(Number(v))) ? null : Number(v);
  const quienEs = (req) => (req.admin && (req.admin.usuario || (req.admin.maestro ? 'maestro' : ''))) || '';
  // Normaliza un SKU para comparar (mayúsculas, solo letras/números) — igual que el frontend.
  const cleanSku = (v) => String(v == null ? '' : v).normalize('NFKD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');

  // ── Logística tramo 2 (hub → Perú): salidas martes/viernes, tránsito 3 días
  //    (EE.UU./Miami) ó 4 días (España/Madrid). Fechas de calendario (simple).
  const HUB_DIAS = (hub) => (hub === 'madrid' || hub === 'espana') ? 4 : 3;
  const hoyISO = () => new Date().toISOString().slice(0, 10);
  const isISO = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
  function proximaSalida(fromStr) {               // próximo martes(2) o viernes(5) ≥ fecha dada
    const base = isISO(fromStr) ? new Date(fromStr + 'T00:00:00') : new Date();
    for (let i = 0; i < 10; i++) {
      const x = new Date(base); x.setDate(base.getDate() + i);
      const dw = x.getDay();
      if (dw === 2 || dw === 5) return x.toISOString().slice(0, 10);
    }
    return hoyISO();
  }
  function etaDesdeSalida(hub, fechaSalida) {      // llegada = salida + días de tránsito
    if (!isISO(fechaSalida)) return null;
    const d = new Date(fechaSalida + 'T00:00:00');
    d.setDate(d.getDate() + HUB_DIAS(hub));
    return d.toISOString().slice(0, 10);
  }
  const tokenRnd = () => (Date.now().toString(36) + Math.random().toString(36).slice(2, 12)).slice(0, 32);

  // ── 17TRACK (opcional): lee el estado del courier del tramo 1 (origen→hub).
  //    Si no hay TRACK17_API_KEY, el módulo funciona 100% manual.
  const TRACK17_KEY = process.env.TRACK17_API_KEY || '';
  async function track17Consultar(numeros) {
    // numeros: ['TRK1','TRK2',...] → { 'TRK1': { estado, resumen } }
    const out = {};
    if (!TRACK17_KEY || !numeros.length) return out;
    const body = JSON.stringify(numeros.slice(0, 40).map(n => ({ number: String(n) })));
    const headers = { 'Content-Type': 'application/json', '17token': TRACK17_KEY };
    try {
      // 1) registrar (idempotente; si ya están, igual responde)
      await fetch('https://api.17track.net/track/v2.2/register', { method: 'POST', headers, body }).catch(() => {});
      // 2) consultar estado
      const r = await fetch('https://api.17track.net/track/v2.2/gettrackinfo', { method: 'POST', headers, body });
      const j = await r.json().catch(() => null);
      const acc = (j && j.data && j.data.accepted) || [];
      acc.forEach(it => {
        const num = String(it.number || '');
        const ti = it.track_info || {};
        const ls = (ti.latest_status || {});
        const le = (ti.latest_event || {});
        const estado = s(ls.status || '').slice(0, 40);               // InfoReceived|InTransit|Delivered|...
        const resumen = s(le.description || ls.sub_status || estado).slice(0, 255);
        if (num) out[num] = { estado, resumen };
      });
    } catch (e) { console.error('[seguimiento] 17track', e.message); }
    return out;
  }

  // Estado del envío EN PALABRAS DEL CLIENTE (sin datos internos).
  const HUB_LABEL = { miami: 'almacén de Miami (EE.UU.)', madrid: 'almacén de Madrid (España)', espana: 'almacén en España', otro: 'almacén internacional' };
  function estadoClienteEnvio(e) {
    const hubTxt = HUB_LABEL[e.hub] || 'almacén internacional';
    const eta = e.eta ? String(e.eta).slice(0, 10) : null;
    if (e.fase === 'recibido' || e.estado === 'recibido') return { clave: 'recibido', texto: 'Recibido en Perú', eta };
    if (e.fase === 'embarcado') return { clave: 'embarcado', texto: 'En camino a Perú', eta };
    if (e.fase === 'en_hub') return { clave: 'en_hub', texto: 'En el ' + hubTxt + ', preparando el envío a Perú', eta: null };
    const ap = s(e.api_resumen);
    return { clave: 'transito', texto: 'En camino al ' + hubTxt + (ap ? (' · ' + ap) : ''), eta: null };
  }

  // Backorders EN VIVO del ERP (SOLO LECTURA). Se usa para traerlos y para sincronizar.
  async function erpBackorders() {
    const [rows] = await prodPool.query(`
      SELECT si.id AS sale_item_id, TRIM(pv.sku) AS sku,
             COALESCE(NULLIF(TRIM(pv.name),''), p.name) AS producto,
             s.code AS venta, s.created_at AS fecha, si.quantity AS cantidad,
             COALESCE(NULLIF(TRIM(cli.business_name),''),
                      NULLIF(TRIM(CONCAT_WS(' ', cli.first_name, cli.last_name)),''), '—') AS cliente
        FROM sale_items si
        JOIN sales s ON s.id = si.sale_id
        JOIN product_variations pv ON pv.id = si.product_variation_id
        JOIN products p ON p.id = pv.product_id
        LEFT JOIN parties cli ON cli.id = s.customer_id
       WHERE si.stock_batch_id IS NULL AND si.is_backorder = 1
         AND s.deleted_at IS NULL AND s.status <> 'cancelled'
       ORDER BY s.created_at DESC, pv.sku
       LIMIT 2000`);
    return rows.map(r => ({
      sale_item_id: String(r.sale_item_id),
      sku: r.sku || '', producto: r.producto || '', cliente: r.cliente || '—',
      venta: r.venta || '', cantidad: Number(r.cantidad) || 0,
      fecha: r.fecha ? String(r.fecha).slice(0, 10) : ''
    }));
  }

  // Referencias de las ENTRADAS del ERP (stock_entries.reference_number), donde
  // el usuario escribe el/los N° de factura al hacer el ingreso. SOLO LECTURA.
  //  Devuelve un Set de "tokens" normalizados (por si en una entrada juntan
  //  varios números separados por coma/espacio/;/|) más las cadenas completas.
  const normRef = (v) => String(v == null ? '' : v).trim().toUpperCase().replace(/\s+/g, '');
  async function erpReferencias() {
    const set = new Set();
    try {
      const [rows] = await prodPool.query(
        `SELECT reference_number FROM stock_entries
          WHERE reference_number IS NOT NULL AND reference_number <> ''
          ORDER BY id DESC LIMIT 5000`);
      rows.forEach(r => {
        const full = normRef(r.reference_number);
        if (full) set.add(full);
        // Partir por separadores comunes por si pusieron varias facturas juntas.
        String(r.reference_number).split(/[,;|]+/).forEach(p => { const t = normRef(p); if (t) set.add(t); });
      });
    } catch (e) { console.error('[seguimiento] erpReferencias', e.message); }
    return set;
  }
  // ¿El N° de factura del envío ya está registrado como entrada en el ERP?
  function facturaIngresada(nFactura, refSet, refArr) {
    const nf = normRef(nFactura);
    if (!nf || nf.length < 4) return false;
    if (refSet.has(nf)) return true;
    // Cobertura extra: alguna referencia CONTIENE el N° de factura (varias juntas
    // sin separador estándar). Se exige longitud >=4 para evitar falsos positivos.
    return refArr.some(ref => ref.includes(nf));
  }

  // ── Reparto global por CANTIDADES ─────────────────────────────────────────
  //  Recalcula desde cero cómo se cubren los backorders con los envíos:
  //   · Backorders activos, del más antiguo al más nuevo (una venta cada uno).
  //   · Envíos en orden de creación; cada ítem reparte su cantidad entre los
  //     backorders del MISMO SKU. Lo que no alcanza a cubrir ningún backorder
  //     queda como SOBRANTE del ítem.
  //  Escribe en cada backorder: cubierto + coberturas[{envio_id,tracking,cant,venta,cliente}].
  //  Escribe en cada ítem de envío: bo_alloc[{bo_id,venta,cliente,cant}] + sobra.
  async function recomputarCoberturas() {
    // Backorders activos, del MÁS ANTIGUO al más nuevo por fecha de venta (se
    // cubren primero los pedidos más viejos). Traemos también el estado actual
    // para escribir SOLO los que cambian (menos consultas = menos recursos).
    const [bo] = await portalPool.query(
      `SELECT id, sku, cantidad, venta, cliente, cubierto, coberturas, tracking
         FROM seg_bo_items WHERE archivado = 0 ORDER BY fecha ASC, creado_en ASC, id ASC`);
    const boSt = bo.map(r => ({
      id: r.id, k: cleanSku(r.sku), need: Number(r.cantidad) || 0, venta: r.venta || '', cliente: r.cliente || '',
      prevCub: Number(r.cubierto) || 0, prevCob: JSON.stringify(asJson(r.coberturas, []) || []), prevTrk: r.tracking || '', cob: []
    }));
    const porSku = {}; boSt.forEach(x => { (porSku[x.k] = porSku[x.k] || []).push(x); });

    const [envs] = await portalPool.query(`SELECT id, tracking, items FROM seg_envios WHERE archivado = 0 ORDER BY creado_en ASC, id ASC`);
    const updEnv = [];
    for (const ev of envs) {
      const items = asJson(ev.items, []) || [];
      const antes = JSON.stringify(items);
      items.forEach(it => {
        it.bo_alloc = []; it.bo_ids = []; it.sobra = 0;
        const k = cleanSku(it.sku); const q = Number(it.cantidad) || 0;
        if (!k || q <= 0) { it.sobra = q > 0 ? q : 0; return; }
        let avail = q;
        for (const bb of (porSku[k] || [])) {
          if (avail <= 0) break;
          const ya = bb.cob.reduce((sm, c) => sm + c.cant, 0);
          const falta = bb.need > 0 ? Math.max(0, bb.need - ya) : 0;
          const give = Math.min(avail, falta);
          if (give > 0) {
            bb.cob.push({ envio_id: ev.id, tracking: ev.tracking || '', cant: give, venta: bb.venta, cliente: bb.cliente });
            it.bo_alloc.push({ bo_id: bb.id, venta: bb.venta, cliente: bb.cliente, cant: give });
            it.bo_ids.push(bb.id);
            avail -= give;
          }
        }
        it.sobra = avail;
        it.es_backorder = it.bo_alloc.length > 0;
      });
      const despues = JSON.stringify(items);
      if (despues !== antes) updEnv.push({ id: ev.id, items: despues }); // solo si cambió
    }

    for (const bb of boSt) {
      const cubierto = bb.cob.reduce((sm, c) => sm + c.cant, 0);
      const cobStr = JSON.stringify(bb.cob);
      const trk = [...new Set(bb.cob.map(c => s(c.tracking)).filter(Boolean))].join(', ');
      if (cubierto === bb.prevCub && cobStr === bb.prevCob && trk === bb.prevTrk) continue; // sin cambios
      await portalPool.query(
        `UPDATE seg_bo_items SET coberturas = ?, cubierto = ?, tracking = ?, envio_id = ? WHERE id = ?`,
        [cobStr, cubierto, trk, (bb.cob.length ? bb.cob[0].envio_id : null), bb.id]);
    }
    for (const e of updEnv) {
      await portalPool.query(`UPDATE seg_envios SET items = ? WHERE id = ?`, [e.items, e.id]);
    }
  }

  // Normaliza una línea de ítem de envío (lo que manda el frontend ya resuelto).
  function itemEnvio(it) {
    it = it || {};
    return {
      codigo:    s(it.codigo).slice(0, 160),                    // código/n° parte de la factura
      desc:      s(it.desc).slice(0, 1000),                     // descripción original (idioma factura)
      desc_es:   s(it.desc_es).slice(0, 1000),                  // traducción al español (IA), completa
      marca:     s(it.marca).slice(0, 120),
      cantidad:  numOrNull(it.cantidad),
      sku:       s(it.sku).slice(0, 120),                       // SKU asignado en el sistema de ventas
      nombre:    s(it.nombre).slice(0, 255),                    // nombre del producto en el sistema
      confianza: s(it.confianza).slice(0, 20),                  // exact | alta | rev | no | manual
      es_backorder: !!it.es_backorder,                          // ¿cubre un producto en backorder?
      bo_ids:    Array.isArray(it.bo_ids) ? it.bo_ids.map(x => s(x).slice(0, 60)).filter(Boolean) : []
    };
  }

  // ════════════════════════════════════════════════════════════════════════
  //  LECTURA (supervisor + maestro)
  // ════════════════════════════════════════════════════════════════════════

  // ── Catálogo del sistema de ventas (solo lectura) → [[sku, name], ...] ─────
  let _catCache = null, _catAt = 0;
  const CAT_TTL = 10 * 60 * 1000;
  app.get('/api/seguimiento/catalogo', authAdmin, mSeg, async (req, res) => {
    try {
      if (_catCache && (Date.now() - _catAt) < CAT_TTL && !req.query.fresh) return res.json(_catCache);
      const [rows] = await prodPool.query(`
        SELECT TRIM(sku) AS sku, name FROM product_variations
         WHERE product_type <> 'variable' AND deleted_at IS NULL
           AND sku IS NOT NULL AND TRIM(sku) <> '' ORDER BY sku`);
      _catCache = rows.map(r => [r.sku, r.name || '']);
      _catAt = Date.now();
      res.json(_catCache);
    } catch (e) {
      console.error('[seguimiento] catalogo', e.message);
      res.status(500).json({ error: 'No se pudo leer el catálogo' });
    }
  });

  // ── Envíos (con sus ítems) ─────────────────────────────────────────────────
  //    ?estado=en_transito|recibido para filtrar.
  app.get('/api/seguimiento/envios', authAdmin, mSeg, async (req, res) => {
    try {
      const w = [], args = [];
      if (req.query.estado) { w.push('estado = ?'); args.push(String(req.query.estado)); }
      if (!req.query.incluir_archivados) w.push('archivado = 0'); // por defecto ocultar los archivados
      let sql = `SELECT * FROM seg_envios` + (w.length ? ' WHERE ' + w.join(' AND ') : '') +
                ` ORDER BY (estado='recibido') ASC, actualizado_en DESC`;
      const [rows] = await portalPool.query(sql, args);
      // El proveedor y el N° de factura SOLO los ve el maestro. Al supervisor ni
      // siquiera se le envían desde el servidor (no basta con ocultarlos en la UI).
      const esMaestro = !!(req.admin && req.admin.maestro);
      res.json(rows.map(r => ({
        id: r.id, tracking: r.tracking, courier: r.courier,
        proveedor: esMaestro ? r.proveedor : '', n_factura: r.n_factura,
        estado: r.estado, fecha_estimada: r.fecha_estimada, archivado: r.archivado ? 1 : 0,
        hub: r.hub || '', fase: r.fase || 'transito',
        fecha_salida: r.fecha_salida ? String(r.fecha_salida).slice(0,10) : null,
        eta: r.eta ? String(r.eta).slice(0,10) : null,
        api_resumen: r.api_resumen || '', api_estado: r.api_estado || '',
        api_at: r.api_at || null,
        nota: r.nota || '', items: asJson(r.items, []) || [],
        creado_por: r.creado_por, creado_en: r.creado_en, actualizado_en: r.actualizado_en
      })));
    } catch (e) {
      console.error('[seguimiento] envios', e.message);
      res.status(500).json({ error: 'No se pudieron leer los envíos' });
    }
  });

  app.get('/api/seguimiento/envio/:id', authAdmin, mSeg, async (req, res) => {
    try {
      const [rows] = await portalPool.query(`SELECT * FROM seg_envios WHERE id = ?`, [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: 'Envío no encontrado' });
      const r = rows[0];
      const esMaestro = !!(req.admin && req.admin.maestro);
      res.json({
        id: r.id, tracking: r.tracking, courier: r.courier,
        proveedor: esMaestro ? r.proveedor : '', n_factura: r.n_factura,
        estado: r.estado, fecha_estimada: r.fecha_estimada,
        nota: r.nota || '', items: asJson(r.items, []) || [],
        creado_por: r.creado_por, creado_en: r.creado_en, actualizado_en: r.actualizado_en
      });
    } catch (e) {
      console.error('[seguimiento] envio', e.message);
      res.status(500).json({ error: 'No se pudo leer el envío' });
    }
  });

  // ── Grupos de backorder ────────────────────────────────────────────────────
  app.get('/api/seguimiento/grupos', authAdmin, mSeg, async (req, res) => {
    try {
      const [rows] = await portalPool.query(`SELECT * FROM seg_grupos ORDER BY orden ASC, creado_en ASC`);
      res.json(rows.map(g => ({
        id: g.id, nombre: g.nombre, vta: g.vta, cliente: g.cliente,
        precio_venta: g.precio_venta, precio_pagado: g.precio_pagado,
        nota: g.nota || '', orden: g.orden,
        creado_en: g.creado_en, actualizado_en: g.actualizado_en
      })));
    } catch (e) {
      console.error('[seguimiento] grupos', e.message);
      res.status(500).json({ error: 'No se pudieron leer los grupos' });
    }
  });

  // ── Ítems de backorder gestionados ─────────────────────────────────────────
  //    ?incluir_archivados=1 para ver también los archivados.
  app.get('/api/seguimiento/bo-items', authAdmin, mSeg, async (req, res) => {
    try {
      let sql = `SELECT * FROM seg_bo_items`;
      if (!req.query.incluir_archivados) sql += ` WHERE archivado = 0`;
      sql += ` ORDER BY fecha ASC, creado_en ASC`; // por fecha de la venta (más antigua primero)
      const [rows] = await portalPool.query(sql);
      res.json(rows.map(b => ({
        id: b.id, grupo_id: b.grupo_id || '', sku: b.sku, nombre: b.nombre,
        cliente: b.cliente, venta: b.venta, cantidad: b.cantidad,
        fecha: b.fecha ? String(b.fecha).slice(0, 10) : '',
        comprado: b.comprado ? 1 : 0, nota: b.nota || '', orden: b.orden,
        origen: b.origen, archivado: b.archivado ? 1 : 0,
        envio_id: b.envio_id || '', tracking: b.tracking || '',
        cubierto: Number(b.cubierto) || 0, coberturas: asJson(b.coberturas, []) || [],
        creado_en: b.creado_en, actualizado_en: b.actualizado_en
      })));
    } catch (e) {
      console.error('[seguimiento] bo-items', e.message);
      res.status(500).json({ error: 'No se pudieron leer los backorders' });
    }
  });

  // ── Resumen (para el badge y las tarjetas) ─────────────────────────────────
  app.get('/api/seguimiento/resumen', authAdmin, mSeg, async (req, res) => {
    try {
      const [[env]] = await portalPool.query(
        `SELECT SUM(estado='en_transito') AS en_transito, SUM(estado='recibido') AS recibido FROM seg_envios`);
      const [[bo]] = await portalPool.query(
        `SELECT SUM(comprado=0) AS sin_comprar, SUM(comprado=1) AS comprados FROM seg_bo_items WHERE archivado = 0`);
      res.json({
        en_transito: Number(env && env.en_transito) || 0,
        recibido: Number(env && env.recibido) || 0,
        bo_sin_comprar: Number(bo && bo.sin_comprar) || 0,
        bo_comprados: Number(bo && bo.comprados) || 0
      });
    } catch (e) { res.json({ en_transito: 0, recibido: 0, bo_sin_comprar: 0, bo_comprados: 0 }); }
  });

  // ════════════════════════════════════════════════════════════════════════
  //  ESCRITURA (solo maestro)
  // ════════════════════════════════════════════════════════════════════════

  // ── Proxy de IA (Gemini) — idéntico a Importaciones, el PDF no se almacena ──
  app.post('/api/seguimiento/ia', authAdmin, mSeg, soloMaestroSeg, async (req, res) => {
    try {
      const key = process.env.GEMINI_API_KEY;
      if (!key) return res.status(500).json({ error: 'GEMINI_API_KEY no está configurada en el servidor' });
      const { model, prompt, pdf_base64 } = req.body || {};
      if (!prompt || !pdf_base64) return res.status(400).json({ error: 'Falta el prompt o el PDF' });
      const mdl = (model || 'gemini-3.6-flash').replace(/[^a-zA-Z0-9.\-]/g, '');
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${mdl}:generateContent?key=${encodeURIComponent(key)}`;
      const body = {
        contents: [{ parts: [
          { inline_data: { mime_type: 'application/pdf', data: pdf_base64 } },
          { text: prompt }
        ] }],
        generationConfig: { temperature: 0, response_mime_type: 'application/json' }
      };
      const g = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const text = await g.text();
      res.status(g.status).type('application/json').send(text);
    } catch (e) {
      console.error('[seguimiento] ia', e.message);
      res.status(500).json({ error: 'Error llamando a la IA' });
    }
  });

  // ── Backorders EN VIVO desde el ERP (para elegir cuáles gestionar) ─────────
  //    SOLO LECTURA. Igual que /api/importacion/backorders pero devuelve el id
  //    del sale_item para poder "fijarlo" en el portal sin perder su estado.
  app.get('/api/seguimiento/erp-backorders', authAdmin, mSeg, soloMaestroSeg, async (req, res) => {
    try { res.json(await erpBackorders()); }
    catch (e) {
      console.error('[seguimiento] erp-backorders', e.message);
      res.status(500).json({ error: 'No se pudieron leer los backorders del sistema' });
    }
  });

  // ── Sincronizar TODOS los backorders del ERP al portal (traerlos por defecto) ─
  //    Inserta los que aún no están fijados (INSERT IGNORE, conserva nota/grupo/
  //    comprado de los existentes). Devuelve cuántos nuevos entraron.
  app.post('/api/seguimiento/bo-items/sync', authAdmin, mSeg, soloMaestroSeg, async (req, res) => {
    try {
      // Throttle: la sincronización con el ERP es lo más caro. Si se pidió hace
      // poco y NO es forzada (botón "Actualizar"), no se vuelve a golpear el ERP.
      const forzar = !!(req.body && req.body.force) || !!req.query.force;
      if (!forzar && (Date.now() - _lastSyncSeg) < SYNC_TTL_SEG) {
        return res.json({ ok: true, throttled: true });
      }

      const lineas = await erpBackorders();
      // Inserta en UNA sola consulta. Para los que ya existen, REFRESCA solo los
      // campos descriptivos del ERP (sku, nombre del HIJO, cliente, venta, fecha)
      // — así los backorders viejos también muestran el nombre correcto — sin tocar
      // la gestión (grupo, nota, comprado, cobertura, archivado).
      let insertados = 0;
      if (lineas.length) {
        const valores = lineas.map(l => [
          'erp:' + l.sale_item_id, s(l.sku).slice(0,120), s(l.producto).slice(0,255), s(l.cliente).slice(0,255),
          s(l.venta).slice(0,120), numOrNull(l.cantidad),
          (l.fecha && /^\d{4}-\d{2}-\d{2}/.test(String(l.fecha))) ? String(l.fecha).slice(0,10) : null, 'erp'
        ]);
        const [r] = await portalPool.query(
          `INSERT INTO seg_bo_items (id, sku, nombre, cliente, venta, cantidad, fecha, origen) VALUES ?
           ON DUPLICATE KEY UPDATE sku=VALUES(sku), nombre=VALUES(nombre), cliente=VALUES(cliente),
             venta=VALUES(venta), cantidad=VALUES(cantidad), fecha=VALUES(fecha)`, [valores]);
        insertados = (r && r.affectedRows) || 0;
      }

      // ── ARCHIVADO AUTOMÁTICO (cuando ya se ingresó al ERP) ────────────────
      //  Un backorder del ERP que YA NO aparece en la lista de pendientes del
      //  sistema significa que su stock ya se ingresó → se archiva solo.
      //  Si reaparece (se vuelve a pedir), se desarchiva.
      const presentes = lineas.map(l => 'erp:' + l.sale_item_id);
      let archivadosBo = 0;
      if (presentes.length) {
        const [a] = await portalPool.query(
          `UPDATE seg_bo_items SET archivado = 1 WHERE origen = 'erp' AND archivado = 0 AND id NOT IN (?)`, [presentes]);
        archivadosBo = (a && a.affectedRows) || 0;
        await portalPool.query(
          `UPDATE seg_bo_items SET archivado = 0 WHERE origen = 'erp' AND archivado = 1 AND id IN (?)`, [presentes]);
      } else {
        const [a] = await portalPool.query(
          `UPDATE seg_bo_items SET archivado = 1 WHERE origen = 'erp' AND archivado = 0`);
        archivadosBo = (a && a.affectedRows) || 0;
      }

      // Recalcular el reparto por cantidades con el set de backorders ya actualizado.
      await recomputarCoberturas();

      //  Un ENVÍO se archiva solo cuando YA SE INGRESÓ AL ERP:
      //   (a) su N° de factura aparece en stock_entries.reference_number, o
      //   (b) todos los backorders que cubre ya se archivaron.
      //  La (a) cubre también los envíos que no tenían ningún backorder.
      let archivadosEnv = 0;
      const [envs] = await portalPool.query(`SELECT id, n_factura, items FROM seg_envios WHERE archivado = 0`);
      if (envs.length) {
        const [boAll] = await portalPool.query(`SELECT id, archivado FROM seg_bo_items`);
        const boArch = {}; boAll.forEach(b => { boArch[b.id] = !!b.archivado; });
        const refSet = await erpReferencias();
        const refArr = [...refSet];
        for (const ev of envs) {
          let archivar = facturaIngresada(ev.n_factura, refSet, refArr); // (a)
          if (!archivar) { // (b)
            const items = asJson(ev.items, []) || [];
            const ids = [];
            items.forEach(it => { if (Array.isArray(it.bo_ids)) it.bo_ids.forEach(x => ids.push(x)); });
            archivar = ids.length > 0 && ids.every(id => boArch[id]);
          }
          if (archivar) {
            await portalPool.query(`UPDATE seg_envios SET archivado = 1 WHERE id = ?`, [ev.id]);
            archivadosEnv++;
          }
        }
      }

      _lastSyncSeg = Date.now();
      res.json({ ok: true, insertados, total: lineas.length, archivados_backorders: archivadosBo, archivados_envios: archivadosEnv });
    } catch (e) {
      console.error('[seguimiento] sync backorders', e.message);
      res.status(500).json({ error: 'No se pudieron sincronizar los backorders' });
    }
  });

  // ── Fijar (importar) líneas de backorder del ERP al portal ─────────────────
  //    Body: { lineas:[{sale_item_id, sku, producto, cliente, venta, cantidad, fecha}] }
  //    Upsert por id 'erp:'+sale_item_id. Conserva grupo/nota/comprado si ya existía.
  app.post('/api/seguimiento/bo-items/importar', authAdmin, mSeg, soloMaestroSeg, async (req, res) => {
    try {
      const lineas = Array.isArray(req.body && req.body.lineas) ? req.body.lineas : [];
      if (!lineas.length) return res.json({ ok: true, insertados: 0 });
      let insertados = 0;
      for (const l of lineas) {
        const sid = s(l && l.sale_item_id).trim();
        if (!sid) continue;
        const id = 'erp:' + sid;
        // Solo inserta si no existe (para no pisar nota/grupo/comprado ya puestos).
        const [r] = await portalPool.query(
          `INSERT IGNORE INTO seg_bo_items (id, sku, nombre, cliente, venta, cantidad, fecha, origen)
           VALUES (?,?,?,?,?,?,?, 'erp')`,
          [id, s(l.sku).slice(0,120), s(l.producto).slice(0,255), s(l.cliente).slice(0,255),
           s(l.venta).slice(0,120), numOrNull(l.cantidad),
           (l.fecha && /^\d{4}-\d{2}-\d{2}/.test(String(l.fecha))) ? String(l.fecha).slice(0,10) : null]);
        if (r && r.affectedRows) insertados++;
      }
      res.json({ ok: true, insertados });
    } catch (e) {
      console.error('[seguimiento] importar backorders', e.message);
      res.status(500).json({ error: 'No se pudieron fijar los backorders' });
    }
  });

  // ── Crear/actualizar un ítem de backorder (editar gestión: grupo, nota, comprado, archivar) ──
  //    El SUPERVISOR también puede: agrupar, poner notas, marcar comprado y archivar.
  //    (Eliminar sigue siendo solo del maestro.)
  app.post('/api/seguimiento/bo-item', authAdmin, mSeg, async (req, res) => {
    try {
      const b = req.body || {};
      const id = s(b.id).trim() || ('man:' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7));
      const origen = id.startsWith('erp:') ? 'erp' : 'manual';
      await portalPool.query(
        `INSERT INTO seg_bo_items (id, grupo_id, sku, nombre, cliente, venta, cantidad, fecha, comprado, nota, orden, origen, archivado)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE grupo_id=VALUES(grupo_id), sku=VALUES(sku), nombre=VALUES(nombre),
           cliente=VALUES(cliente), venta=VALUES(venta), cantidad=VALUES(cantidad), fecha=VALUES(fecha),
           comprado=VALUES(comprado), nota=VALUES(nota), orden=VALUES(orden), archivado=VALUES(archivado)`,
        [id, s(b.grupo_id).trim() || null, s(b.sku).slice(0,120), s(b.nombre).slice(0,255),
         s(b.cliente).slice(0,255), s(b.venta).slice(0,120), numOrNull(b.cantidad),
         (b.fecha && /^\d{4}-\d{2}-\d{2}/.test(String(b.fecha))) ? String(b.fecha).slice(0,10) : null,
         b.comprado ? 1 : 0, s(b.nota).slice(0, 2000), +b.orden || 0, origen, b.archivado ? 1 : 0]);
      res.json({ ok: true, id });
    } catch (e) {
      console.error('[seguimiento] bo-item', e.message);
      res.status(500).json({ error: 'No se pudo guardar el backorder' });
    }
  });

  app.delete('/api/seguimiento/bo-item/:id', authAdmin, mSeg, soloMaestroSeg, async (req, res) => {
    try {
      await portalPool.query(`DELETE FROM seg_bo_items WHERE id = ?`, [req.params.id]);
      res.json({ ok: true });
    } catch (e) {
      console.error('[seguimiento] del bo-item', e.message);
      res.status(500).json({ error: 'No se pudo eliminar' });
    }
  });

  // ── Crear/actualizar un grupo (el supervisor también puede agrupar) ────────
  app.post('/api/seguimiento/grupo', authAdmin, mSeg, async (req, res) => {
    try {
      const b = req.body || {};
      const id = s(b.id).trim() || ('grp:' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7));
      await portalPool.query(
        `INSERT INTO seg_grupos (id, nombre, vta, cliente, precio_venta, precio_pagado, nota, orden)
         VALUES (?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE nombre=VALUES(nombre), vta=VALUES(vta), cliente=VALUES(cliente),
           precio_venta=VALUES(precio_venta), precio_pagado=VALUES(precio_pagado), nota=VALUES(nota), orden=VALUES(orden)`,
        [id, s(b.nombre).slice(0,200), s(b.vta).slice(0,120), s(b.cliente).slice(0,255),
         numOrNull(b.precio_venta), numOrNull(b.precio_pagado), s(b.nota).slice(0, 2000), +b.orden || 0]);
      res.json({ ok: true, id });
    } catch (e) {
      console.error('[seguimiento] grupo', e.message);
      res.status(500).json({ error: 'No se pudo guardar el grupo' });
    }
  });

  // ── Eliminar un grupo (sus ítems quedan sin grupo, no se borran) ───────────
  app.delete('/api/seguimiento/grupo/:id', authAdmin, mSeg, soloMaestroSeg, async (req, res) => {
    try {
      await portalPool.query(`UPDATE seg_bo_items SET grupo_id = NULL WHERE grupo_id = ?`, [req.params.id]);
      await portalPool.query(`DELETE FROM seg_grupos WHERE id = ?`, [req.params.id]);
      res.json({ ok: true });
    } catch (e) {
      console.error('[seguimiento] del grupo', e.message);
      res.status(500).json({ error: 'No se pudo eliminar el grupo' });
    }
  });

  // ── Crear/actualizar un envío (tracking + ítems leídos de la factura) ──────
  app.post('/api/seguimiento/envio', authAdmin, mSeg, soloMaestroSeg, async (req, res) => {
    try {
      const b = req.body || {};
      const id = s(b.id).trim() || ('env:' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7));
      const items = Array.isArray(b.items) ? b.items.map(itemEnvio) : [];
      const tracking = s(b.tracking).slice(0, 160);

      // ¿Ya existía? conservar creado_por.
      const [prev] = await portalPool.query(`SELECT creado_por FROM seg_envios WHERE id = ?`, [id]);
      const creadoPor = (prev.length && prev[0].creado_por) ? prev[0].creado_por : quienEs(req);
      await portalPool.query(
        `INSERT INTO seg_envios (id, tracking, courier, proveedor, n_factura, estado, fecha_estimada, nota, items, creado_por)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE tracking=VALUES(tracking), courier=VALUES(courier), proveedor=VALUES(proveedor),
           n_factura=VALUES(n_factura), estado=VALUES(estado), fecha_estimada=VALUES(fecha_estimada),
           nota=VALUES(nota), items=VALUES(items)`,
        [id, tracking, s(b.courier).slice(0,80), s(b.proveedor).slice(0,255),
         s(b.n_factura).slice(0,160), (b.estado === 'recibido' ? 'recibido' : 'en_transito'),
         (b.fecha_estimada && /^\d{4}-\d{2}-\d{2}/.test(String(b.fecha_estimada))) ? String(b.fecha_estimada).slice(0,10) : null,
         s(b.nota).slice(0, 2000), JSON.stringify(items), creadoPor]);

      // Recalcular TODO el reparto por cantidades (deja cada backorder con su
      // cobertura y cada ítem de envío con su desglose y sobrante).
      await recomputarCoberturas();
      res.json({ ok: true, id });
    } catch (e) {
      console.error('[seguimiento] envio guardar', e.message);
      res.status(500).json({ error: 'No se pudo guardar el envío' });
    }
  });

  // ── Cambiar estado del envío (en_transito ↔ recibido) ──────────────────────
  app.put('/api/seguimiento/envio/:id/estado', authAdmin, mSeg, soloMaestroSeg, async (req, res) => {
    try {
      const estado = (req.body && req.body.estado === 'recibido') ? 'recibido' : 'en_transito';
      await portalPool.query(`UPDATE seg_envios SET estado = ? WHERE id = ?`, [estado, req.params.id]);
      res.json({ ok: true, estado });
    } catch (e) {
      console.error('[seguimiento] envio estado', e.message);
      res.status(500).json({ error: 'No se pudo cambiar el estado' });
    }
  });

  // ── Logística del envío: hub destino, fase y salida/ETA (solo maestro) ─────
  app.put('/api/seguimiento/envio/:id/logistica', authAdmin, mSeg, soloMaestroSeg, async (req, res) => {
    try {
      const b = req.body || {};
      const hub = ['miami', 'madrid', 'espana', 'otro'].includes(s(b.hub)) ? s(b.hub) : '';
      const fase = ['transito', 'en_hub', 'embarcado', 'recibido'].includes(s(b.fase)) ? s(b.fase) : 'transito';
      let fsal = isISO(b.fecha_salida) ? String(b.fecha_salida).slice(0, 10) : null;
      let eta = null;
      if (fase === 'embarcado') { if (!fsal) fsal = proximaSalida(hoyISO()); eta = etaDesdeSalida(hub, fsal); }
      const estado = fase === 'recibido' ? 'recibido' : 'en_transito';
      await portalPool.query(
        `UPDATE seg_envios SET hub=?, fase=?, fecha_salida=?, eta=?, estado=? WHERE id=?`,
        [hub, fase, fsal, eta, estado, req.params.id]);
      res.json({ ok: true, hub, fase, fecha_salida: fsal, eta });
    } catch (e) {
      console.error('[seguimiento] logistica', e.message);
      res.status(500).json({ error: 'No se pudo guardar la logística' });
    }
  });

  // ── Actualizar estado del courier (tramo 1) vía 17TRACK — throttle 3 días ──
  //    Si no hay API configurada, responde modo manual. El botón manda force:true.
  let _lastTrack = 0; const TRACK_TTL = 3 * 24 * 60 * 60 * 1000;
  app.post('/api/seguimiento/track-refresh', authAdmin, mSeg, soloMaestroSeg, async (req, res) => {
    try {
      if (!TRACK17_KEY) return res.json({ ok: true, api: false, msg: 'Sin API de tracking configurada (modo manual).' });
      const forzar = !!(req.body && req.body.force);
      if (!forzar && (Date.now() - _lastTrack) < TRACK_TTL) return res.json({ ok: true, api: true, throttled: true });
      const [rows] = await portalPool.query(
        `SELECT id, tracking FROM seg_envios WHERE archivado = 0 AND fase = 'transito' AND tracking <> ''`);
      const nums = [...new Set(rows.map(r => s(r.tracking)).filter(Boolean))];
      const info = await track17Consultar(nums);
      let n = 0;
      for (const r of rows) {
        const d = info[s(r.tracking)];
        if (!d) continue;
        await portalPool.query(`UPDATE seg_envios SET api_estado=?, api_resumen=?, api_at=NOW() WHERE id=?`, [d.estado, d.resumen, r.id]);
        n++;
      }
      _lastTrack = Date.now();
      res.json({ ok: true, api: true, actualizados: n, total: nums.length });
    } catch (e) {
      console.error('[seguimiento] track-refresh', e.message);
      res.status(500).json({ error: 'No se pudo actualizar el tracking' });
    }
  });

  // ── Link de seguimiento público por CLIENTE (lo genera el maestro) ─────────
  app.get('/api/seguimiento/cliente-link', authAdmin, mSeg, async (req, res) => {
    try {
      const cliente = s(req.query.cliente).trim();
      if (!cliente) return res.status(400).json({ error: 'Falta el cliente' });
      const [ex] = await portalPool.query(`SELECT token FROM seg_cliente_token WHERE cliente = ? LIMIT 1`, [cliente]);
      let token = ex.length ? ex[0].token : tokenRnd();
      if (!ex.length) await portalPool.query(`INSERT INTO seg_cliente_token (token, cliente) VALUES (?,?)`, [token, cliente]);
      res.json({ ok: true, token, cliente, path: '/seguimiento-cliente.html?t=' + encodeURIComponent(token) });
    } catch (e) {
      console.error('[seguimiento] cliente-link', e.message);
      res.status(500).json({ error: 'No se pudo generar el link' });
    }
  });

  // ── PÚBLICO (SIN login): el cliente ve el estado de SU pedido por su token ──
  app.get('/api/seg-publico/:token', async (req, res) => {
    try {
      const [t] = await portalPool.query(`SELECT cliente FROM seg_cliente_token WHERE token = ? LIMIT 1`, [req.params.token]);
      if (!t.length) return res.status(404).json({ error: 'Enlace no válido' });
      const cliente = t[0].cliente;
      const [bo] = await portalPool.query(
        `SELECT producto, cantidad, cubierto, coberturas FROM seg_bo_items
          WHERE cliente = ? AND archivado = 0 ORDER BY fecha ASC, creado_en ASC`, [cliente]);
      const envioIds = new Set();
      bo.forEach(b => { (asJson(b.coberturas, []) || []).forEach(c => { if (c && c.envio_id) envioIds.add(c.envio_id); }); });
      const envMap = {};
      if (envioIds.size) {
        const [envs] = await portalPool.query(
          `SELECT id, hub, fase, estado, eta, api_resumen, api_at, actualizado_en FROM seg_envios WHERE id IN (?)`, [[...envioIds]]);
        envs.forEach(e => { envMap[e.id] = e; });
      }
      let ultima = null;
      const items = bo.map(b => {
        const cob = asJson(b.coberturas, []) || [];
        const prim = cob.find(c => c && c.envio_id && envMap[c.envio_id]);
        let estado = 'En proceso de compra', eta = null;
        if (prim) {
          const e = envMap[prim.envio_id];
          const info = estadoClienteEnvio(e);
          estado = info.texto; eta = info.eta;
          const at = e.api_at || e.actualizado_en;
          if (at && (!ultima || at > ultima)) ultima = at;
        }
        return { producto: b.producto || '', cantidad: b.cantidad, estado, eta };
      });
      res.json({ ok: true, cliente, items, actualizado: ultima, nota: 'Este seguimiento se actualiza cada 3 días.' });
    } catch (e) {
      console.error('[seguimiento] publico', e.message);
      res.status(500).json({ error: 'No se pudo cargar el seguimiento' });
    }
  });

  // ── Archivar / desarchivar un envío (cuando ya se ingresó al ERP) ──────────
  //    Disponible para el maestro y el supervisor. ?deshacer=1 lo desarchiva.
  app.put('/api/seguimiento/envio/:id/archivar', authAdmin, mSeg, async (req, res) => {
    try {
      const val = req.query.deshacer ? 0 : 1;
      await portalPool.query(`UPDATE seg_envios SET archivado = ? WHERE id = ?`, [val, req.params.id]);
      res.json({ ok: true, archivado: val });
    } catch (e) {
      console.error('[seguimiento] archivar envio', e.message);
      res.status(500).json({ error: 'No se pudo archivar el envío' });
    }
  });

  // ── Eliminar un envío ──────────────────────────────────────────────────────
  app.delete('/api/seguimiento/envio/:id', authAdmin, mSeg, soloMaestroSeg, async (req, res) => {
    try {
      await portalPool.query(`DELETE FROM seg_envios WHERE id = ?`, [req.params.id]);
      await recomputarCoberturas(); // recalcular el reparto sin este envío
      res.json({ ok: true });
    } catch (e) {
      console.error('[seguimiento] del envio', e.message);
      res.status(500).json({ error: 'No se pudo eliminar el envío' });
    }
  });

  return { prepararTablas };
};
