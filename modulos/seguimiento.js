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

  // Backorders EN VIVO del ERP (SOLO LECTURA). Se usa para traerlos y para sincronizar.
  async function erpBackorders() {
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
      sql += ` ORDER BY orden ASC, creado_en ASC`;
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
      const lineas = await erpBackorders();
      let insertados = 0;
      for (const l of lineas) {
        const id = 'erp:' + l.sale_item_id;
        const [r] = await portalPool.query(
          `INSERT IGNORE INTO seg_bo_items (id, sku, nombre, cliente, venta, cantidad, fecha, origen)
           VALUES (?,?,?,?,?,?,?, 'erp')`,
          [id, s(l.sku).slice(0,120), s(l.producto).slice(0,255), s(l.cliente).slice(0,255),
           s(l.venta).slice(0,120), numOrNull(l.cantidad),
           (l.fecha && /^\d{4}-\d{2}-\d{2}/.test(String(l.fecha))) ? String(l.fecha).slice(0,10) : null]);
        if (r && r.affectedRows) insertados++;
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

      // ── RELACIÓN con los backorders POR CANTIDADES ───────────────────────
      //  Cada ítem del envío aporta una cantidad. Se reparte entre los backorders
      //  del mismo SKU, del MÁS ANTIGUO al más nuevo, cubriendo completo o parcial.
      //  Cada backorder guarda `coberturas`=[{envio_id,tracking,cant}] y
      //  `cubierto`=suma. "faltan" = cantidad − cubierto.
      const traigo = {}; // sku normalizado -> unidades que trae ESTE envío
      items.forEach(it => { const k = cleanSku(it.sku); const q = Number(it.cantidad) || 0; if (k && q > 0) traigo[k] = (traigo[k] || 0) + q; });

      // Backorders candidatos (no archivados), del más antiguo al más nuevo.
      const [bo] = await portalPool.query(
        `SELECT id, sku, cantidad, coberturas FROM seg_bo_items WHERE archivado = 0 ORDER BY creado_en ASC, id ASC`);
      const estado = bo.map(r => {
        let cob = asJson(r.coberturas, []) || [];
        const teniaMio = cob.some(c => c && c.envio_id === id);
        cob = cob.filter(c => c && c.envio_id !== id); // quitar la cobertura previa de ESTE envío
        const otros = cob.reduce((sm, c) => sm + (Number(c.cant) || 0), 0);
        return { id: r.id, k: cleanSku(r.sku), need: Number(r.cantidad) || 0, cob, otros, mine: 0, teniaMio };
      });

      // Repartir lo que trae este envío por SKU (más antiguo primero).
      Object.keys(traigo).forEach(k => {
        let avail = traigo[k];
        for (const st of estado) {
          if (avail <= 0) break;
          if (st.k !== k) continue;
          const falta = st.need > 0 ? Math.max(0, st.need - st.otros - st.mine) : 0;
          const give = Math.min(avail, falta);
          if (give > 0) { st.mine += give; avail -= give; }
        }
      });

      // Guardar la cobertura en cada backorder afectado y anotar en el ítem del
      // envío a qué backorders (y cuántas unidades) fue.
      const asignPorItem = items.map(() => []); // por índice de ítem: [{bo_id, cant}]
      for (const st of estado) {
        if (st.mine <= 0 && !st.teniaMio) continue; // no lo tocamos
        const cobNueva = st.cob.slice();
        if (st.mine > 0) cobNueva.push({ envio_id: id, tracking, cant: st.mine });
        const cubierto = cobNueva.reduce((sm, c) => sm + (Number(c.cant) || 0), 0);
        const trk = [...new Set(cobNueva.map(c => s(c.tracking)).filter(Boolean))].join(', ');
        await portalPool.query(
          `UPDATE seg_bo_items SET coberturas = ?, cubierto = ?, tracking = ?, envio_id = ? WHERE id = ?`,
          [JSON.stringify(cobNueva), cubierto, trk, (cobNueva.length ? id : null), st.id]);
      }
      // Anotar en cada ítem del envío los backorders que cubrió (por SKU, respetando el reparto).
      const restoPorSku = {}; Object.keys(traigo).forEach(k => { restoPorSku[k] = estado.filter(st => st.k === k && st.mine > 0).map(st => ({ id: st.id, cant: st.mine })); });
      items.forEach((it, idx) => {
        const k = cleanSku(it.sku);
        const lista = restoPorSku[k] || [];
        it.bo_ids = lista.map(x => x.id);
        if (lista.length) it.es_backorder = true;
      });

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
      res.json({ ok: true, id, backorders_vinculados: estado.filter(st => st.mine > 0).length });
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
      const eid = req.params.id;
      // Soltar la cobertura que este envío aportaba a cada backorder (recomputar cubierto).
      const [bo] = await portalPool.query(`SELECT id, coberturas FROM seg_bo_items WHERE archivado = 0`);
      for (const r of bo) {
        let cob = asJson(r.coberturas, []) || [];
        if (!cob.some(c => c && c.envio_id === eid)) continue;
        cob = cob.filter(c => c && c.envio_id !== eid);
        const cubierto = cob.reduce((sm, c) => sm + (Number(c.cant) || 0), 0);
        const trk = [...new Set(cob.map(c => s(c.tracking)).filter(Boolean))].join(', ');
        await portalPool.query(
          `UPDATE seg_bo_items SET coberturas = ?, cubierto = ?, tracking = ?, envio_id = ? WHERE id = ?`,
          [JSON.stringify(cob), cubierto, trk, (cob.length ? cob[cob.length - 1].envio_id : null), r.id]);
      }
      await portalPool.query(`DELETE FROM seg_envios WHERE id = ?`, [eid]);
      res.json({ ok: true });
    } catch (e) {
      console.error('[seguimiento] del envio', e.message);
      res.status(500).json({ error: 'No se pudo eliminar el envío' });
    }
  });

  return { prepararTablas };
};
