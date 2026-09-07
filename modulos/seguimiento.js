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
        creado_en      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        actualizado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX (grupo_id), INDEX (sku), INDEX (comprado), INDEX (archivado)
      )`);

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
        creado_en      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        actualizado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX (tracking), INDEX (estado)
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

  // Normaliza una línea de ítem de envío (lo que manda el frontend ya resuelto).
  function itemEnvio(it) {
    it = it || {};
    return {
      codigo:    s(it.codigo).slice(0, 120),                    // código/n° parte de la factura
      desc:      s(it.desc).slice(0, 500),                      // descripción original (idioma factura)
      desc_es:   s(it.desc_es).slice(0, 500),                   // traducción al español (IA)
      marca:     s(it.marca).slice(0, 120),
      cantidad:  numOrNull(it.cantidad),
      sku:       s(it.sku).slice(0, 120),                       // SKU asignado en el sistema de ventas
      nombre:    s(it.nombre).slice(0, 255),                    // nombre del producto en el sistema
      confianza: s(it.confianza).slice(0, 20),                  // exact | alta | rev | no | manual
      es_backorder: !!it.es_backorder,                          // ¿cubre un producto en backorder?
      bo_id:     s(it.bo_id).slice(0, 60)                       // ítem de backorder vinculado (opcional)
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
      let sql = `SELECT * FROM seg_envios`, args = [];
      if (req.query.estado) { sql += ` WHERE estado = ?`; args.push(String(req.query.estado)); }
      sql += ` ORDER BY (estado='recibido') ASC, actualizado_en DESC`;
      const [rows] = await portalPool.query(sql, args);
      res.json(rows.map(r => ({
        id: r.id, tracking: r.tracking, courier: r.courier, proveedor: r.proveedor,
        n_factura: r.n_factura, estado: r.estado, fecha_estimada: r.fecha_estimada,
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
      res.json({
        id: r.id, tracking: r.tracking, courier: r.courier, proveedor: r.proveedor,
        n_factura: r.n_factura, estado: r.estado, fecha_estimada: r.fecha_estimada,
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
      sql += ` ORDER BY orden ASC, creado_en ASC`;
      const [rows] = await portalPool.query(sql);
      res.json(rows.map(b => ({
        id: b.id, grupo_id: b.grupo_id || '', sku: b.sku, nombre: b.nombre,
        cliente: b.cliente, venta: b.venta, cantidad: b.cantidad,
        fecha: b.fecha ? String(b.fecha).slice(0, 10) : '',
        comprado: b.comprado ? 1 : 0, nota: b.nota || '', orden: b.orden,
        origen: b.origen, archivado: b.archivado ? 1 : 0,
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
    try {
      const [rows] = await prodPool.query(`
        SELECT si.id AS sale_item_id, TRIM(pv.sku) AS sku, p.name AS producto,
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
         LIMIT 1000`);
      res.json(rows.map(r => ({
        sale_item_id: String(r.sale_item_id),
        sku: r.sku || '', producto: r.producto || '', cliente: r.cliente || '—',
        venta: r.venta || '', cantidad: Number(r.cantidad) || 0,
        fecha: r.fecha ? String(r.fecha).slice(0, 10) : ''
      })));
    } catch (e) {
      console.error('[seguimiento] erp-backorders', e.message);
      res.status(500).json({ error: 'No se pudieron leer los backorders del sistema' });
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

  // ── Crear/actualizar un ítem de backorder (manual o editar gestión) ────────
  app.post('/api/seguimiento/bo-item', authAdmin, mSeg, soloMaestroSeg, async (req, res) => {
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

  // ── Crear/actualizar un grupo ──────────────────────────────────────────────
  app.post('/api/seguimiento/grupo', authAdmin, mSeg, soloMaestroSeg, async (req, res) => {
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
      // ¿Ya existía? conservar creado_por.
      const [prev] = await portalPool.query(`SELECT creado_por FROM seg_envios WHERE id = ?`, [id]);
      const creadoPor = (prev.length && prev[0].creado_por) ? prev[0].creado_por : quienEs(req);
      await portalPool.query(
        `INSERT INTO seg_envios (id, tracking, courier, proveedor, n_factura, estado, fecha_estimada, nota, items, creado_por)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE tracking=VALUES(tracking), courier=VALUES(courier), proveedor=VALUES(proveedor),
           n_factura=VALUES(n_factura), estado=VALUES(estado), fecha_estimada=VALUES(fecha_estimada),
           nota=VALUES(nota), items=VALUES(items)`,
        [id, s(b.tracking).slice(0,160), s(b.courier).slice(0,80), s(b.proveedor).slice(0,255),
         s(b.n_factura).slice(0,160), (b.estado === 'recibido' ? 'recibido' : 'en_transito'),
         (b.fecha_estimada && /^\d{4}-\d{2}-\d{2}/.test(String(b.fecha_estimada))) ? String(b.fecha_estimada).slice(0,10) : null,
         s(b.nota).slice(0, 2000), JSON.stringify(items), creadoPor]);
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

  // ── Eliminar un envío ──────────────────────────────────────────────────────
  app.delete('/api/seguimiento/envio/:id', authAdmin, mSeg, soloMaestroSeg, async (req, res) => {
    try {
      await portalPool.query(`DELETE FROM seg_envios WHERE id = ?`, [req.params.id]);
      res.json({ ok: true });
    } catch (e) {
      console.error('[seguimiento] del envio', e.message);
      res.status(500).json({ error: 'No se pudo eliminar el envío' });
    }
  });

  return { prepararTablas };
};
