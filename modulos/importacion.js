// ═══════════════════════════════════════════════════════════════════════════
//  MÓDULO: Importaciones (costeo de importación / landed cost)
//  La app vive en /importacion.html (dentro del panel admin, pestaña 🚢).
//
//  - CATÁLOGO: se LEE en vivo del sistema de ventas de Renzo (prodPool →
//    product_variations), SOLO LECTURA, excluyendo los productos padre
//    ('variable'). No se copia ni se guarda: siempre refleja lo que hay en
//    ventas.
//  - TASAS por partida, IMPORTACIONES guardadas y MEMORIA producto↔partida:
//    se guardan en la base del PORTAL (portalPool), en las tablas imp_*.
//  - IA (Gemini): el navegador manda { model, prompt, pdf_base64 } y el
//    servidor le agrega la CLAVE (GEMINI_API_KEY) y reenvía a Google. El PDF
//    NO se almacena: solo vive en memoria durante el reenvío.
//
//  Todo va protegido por authAdmin + requiereModulo('importaciones').
// ═══════════════════════════════════════════════════════════════════════════

module.exports = function registrarImportacion({
  app, authAdmin, requiereModulo, prodPool, portalPool
}) {

  const mImp = requiereModulo('importaciones'); // solo admins con el módulo (el maestro siempre pasa)

  // ── Preparar las tablas del portal (se llama una vez al arrancar) ──────────
  async function prepararTablas() {
    // Tasas por partida arancelaria: un solo registro con el arreglo completo en JSON.
    await portalPool.query(`
      CREATE TABLE IF NOT EXISTS imp_partidas (
        id   TINYINT UNSIGNED PRIMARY KEY,
        data JSON NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )`);
    // Memoria producto ↔ partida: un solo registro, objeto JSON.
    await portalPool.query(`
      CREATE TABLE IF NOT EXISTS imp_partida_mem (
        id   TINYINT UNSIGNED PRIMARY KEY,
        data JSON NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )`);
    // Importaciones guardadas (cotizaciones y compras): una fila por importación.
    await portalPool.query(`
      CREATE TABLE IF NOT EXISTS imp_importaciones (
        id     VARCHAR(40) PRIMARY KEY,
        n      INT UNSIGNED NOT NULL DEFAULT 0,
        tipo   VARCHAR(20)  NOT NULL DEFAULT '',
        codigo VARCHAR(80)  NOT NULL DEFAULT '',
        rec    JSON NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX (n), INDEX (codigo), INDEX (tipo)
      )`);
  }

  // Helper: parsea JSON que puede venir como string o ya como objeto (mysql2 con
  // columnas JSON a veces devuelve el objeto ya parseado).
  const asJson = (v, fallback) => {
    if (v == null) return fallback;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch (e) { return fallback; }
  };

  // ── 1) CATÁLOGO (solo lectura, desde Renzo) → [[sku, name], ...] ───────────
  //    Excluye 'variable' (productos padre) y borrados. TRIM al sku (a veces
  //    trae tabuladores/espacios). Caché en memoria de 10 min.
  let _catCache = null, _catAt = 0;
  const CAT_TTL = 10 * 60 * 1000;

  app.get('/api/importacion/catalogo', authAdmin, mImp, async (req, res) => {
    try {
      if (_catCache && (Date.now() - _catAt) < CAT_TTL && !req.query.fresh) {
        return res.json(_catCache);
      }
      const [rows] = await prodPool.query(`
        SELECT TRIM(sku) AS sku, name
          FROM product_variations
         WHERE product_type <> 'variable'
           AND deleted_at IS NULL
           AND sku IS NOT NULL AND TRIM(sku) <> ''
         ORDER BY sku`);
      _catCache = rows.map(r => [r.sku, r.name || '']);
      _catAt = Date.now();
      res.json(_catCache);
    } catch (e) {
      console.error('[importacion] catalogo', e.message);
      res.status(500).json({ error: 'No se pudo leer el catálogo' });
    }
  });

  // ── 2) TASAS POR PARTIDA (portal) — se guarda/lee el arreglo completo ──────
  app.get('/api/importacion/partidas', authAdmin, mImp, async (req, res) => {
    try {
      const [rows] = await portalPool.query(`SELECT data FROM imp_partidas WHERE id = 1`);
      res.json(rows.length ? asJson(rows[0].data, null) : null); // null => la app usa DEFAULT_PARTIDAS
    } catch (e) {
      console.error('[importacion] get partidas', e.message);
      res.status(500).json({ error: 'No se pudieron leer las partidas' });
    }
  });

  app.put('/api/importacion/partidas', authAdmin, mImp, async (req, res) => {
    try {
      const data = JSON.stringify(Array.isArray(req.body) ? req.body : []);
      await portalPool.query(
        `INSERT INTO imp_partidas (id, data) VALUES (1, ?)
         ON DUPLICATE KEY UPDATE data = VALUES(data)`, [data]);
      res.json({ ok: true });
    } catch (e) {
      console.error('[importacion] put partidas', e.message);
      res.status(500).json({ error: 'No se pudieron guardar las partidas' });
    }
  });

  // ── 3) MEMORIA producto↔partida (portal) — objeto JSON ─────────────────────
  app.get('/api/importacion/partida-mem', authAdmin, mImp, async (req, res) => {
    try {
      const [rows] = await portalPool.query(`SELECT data FROM imp_partida_mem WHERE id = 1`);
      res.json(rows.length ? asJson(rows[0].data, {}) : {});
    } catch (e) {
      console.error('[importacion] get mem', e.message);
      res.status(500).json({ error: 'No se pudo leer la memoria' });
    }
  });

  app.put('/api/importacion/partida-mem', authAdmin, mImp, async (req, res) => {
    try {
      const data = JSON.stringify(req.body && typeof req.body === 'object' ? req.body : {});
      await portalPool.query(
        `INSERT INTO imp_partida_mem (id, data) VALUES (1, ?)
         ON DUPLICATE KEY UPDATE data = VALUES(data)`, [data]);
      res.json({ ok: true });
    } catch (e) {
      console.error('[importacion] put mem', e.message);
      res.status(500).json({ error: 'No se pudo guardar la memoria' });
    }
  });

  // ── 4) IMPORTACIONES GUARDADAS (portal) — una fila por importación ─────────
  app.get('/api/importacion/importaciones', authAdmin, mImp, async (req, res) => {
    try {
      const [rows] = await portalPool.query(`SELECT rec FROM imp_importaciones ORDER BY n ASC`);
      res.json(rows.map(r => asJson(r.rec, null)).filter(Boolean));
    } catch (e) {
      console.error('[importacion] get importaciones', e.message);
      res.status(500).json({ error: 'No se pudieron leer las importaciones' });
    }
  });

  app.post('/api/importacion/importaciones', authAdmin, mImp, async (req, res) => {
    try {
      const rec = req.body;
      if (!rec || !rec.id) return res.status(400).json({ error: 'Falta el registro' });
      const codigo = (rec.meta && (rec.meta.codigo || rec.meta.numImp)) || '';
      await portalPool.query(
        `INSERT INTO imp_importaciones (id, n, tipo, codigo, rec) VALUES (?,?,?,?,?)
         ON DUPLICATE KEY UPDATE n=VALUES(n), tipo=VALUES(tipo), codigo=VALUES(codigo), rec=VALUES(rec)`,
        [String(rec.id), +rec.n || 0, String(rec.tipo || ''), String(codigo), JSON.stringify(rec)]);
      res.json({ ok: true });
    } catch (e) {
      console.error('[importacion] post importacion', e.message);
      res.status(500).json({ error: 'No se pudo guardar la importación' });
    }
  });

  app.delete('/api/importacion/importaciones/:id', authAdmin, mImp, async (req, res) => {
    try {
      await portalPool.query(`DELETE FROM imp_importaciones WHERE id = ?`, [req.params.id]);
      res.json({ ok: true });
    } catch (e) {
      console.error('[importacion] delete importacion', e.message);
      res.status(500).json({ error: 'No se pudo eliminar' });
    }
  });

  // ── 5) PROXY DE IA (Gemini) ────────────────────────────────────────────────
  //    El navegador manda { model, prompt, pdf_base64 }. El servidor agrega la
  //    CLAVE y reenvía a Google. Devuelve la respuesta cruda de Gemini (la app
  //    ya parsea candidates[].content.parts[].text). El PDF NO se almacena.
  //    OJO: el body trae el PDF en base64 (varios MB). El parser global de
  //    index.js debe permitir ese tamaño (ver el express.json({limit}) de ahí).
  app.post('/api/importacion/ia', authAdmin, mImp, async (req, res) => {
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
      const g = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const text = await g.text(); // reenvía tal cual
      res.status(g.status).type('application/json').send(text);
    } catch (e) {
      console.error('[importacion] ia', e.message);
      res.status(500).json({ error: 'Error llamando a la IA' });
    }
  });

  // ── BACKORDERS (ventas "a pedido" esperando stock) por SKU ─────────────────
  //    Para el export de Ingreso: qué ventas pendientes se pueden despachar con
  //    lo que está ingresando. SOLO LECTURA del ERP.
  app.post('/api/importacion/backorders', authAdmin, mImp, async (req, res) => {
    try {
      const skus = Array.isArray(req.body && req.body.skus)
        ? [...new Set(req.body.skus.map(s => String(s || '').trim()).filter(Boolean))] : [];
      if (!skus.length) return res.json([]);
      const [rows] = await prodPool.query(`
        SELECT TRIM(pv.sku) AS sku, p.name AS producto, s.code AS venta,
               s.created_at AS fecha, si.quantity AS cantidad,
               COALESCE(NULLIF(TRIM(cli.business_name),''),
                        NULLIF(TRIM(CONCAT_WS(' ', cli.first_name, cli.last_name)),''), '—') AS cliente
          FROM sale_items si
          JOIN sales s ON s.id = si.sale_id
          JOIN product_variations pv ON pv.id = si.product_variation_id
          JOIN products p ON p.id = pv.product_id
          LEFT JOIN parties cli ON cli.id = s.customer_id
         WHERE si.stock_batch_id IS NULL AND si.is_backorder = 1
           AND s.deleted_at IS NULL AND s.status <> 'cancelled'
           AND TRIM(pv.sku) IN (?)
         ORDER BY pv.sku, s.created_at`, [skus]);
      res.json(rows.map(r => ({
        sku: r.sku, producto: r.producto || '', cliente: r.cliente || '—',
        venta: r.venta || '', cantidad: Number(r.cantidad) || 0,
        fecha: r.fecha ? String(r.fecha).slice(0, 10) : ''
      })));
    } catch (e) {
      console.error('[importacion] backorders', e.message);
      res.status(500).json({ error: 'No se pudieron leer los productos a pedido' });
    }
  });

  // ── ¿Ya se subió al ERP? Busca el código de importación en el campo de
  //    referencia del ingreso de Renzo (stock_entries). Detecta sola la columna
  //    (nombre con ref/import/doc/guía/comprobante/nota/code). SOLO LECTURA.
  let _refCols = null;
  async function columnasRefEntries() {
    if (_refCols !== null) return _refCols;
    try {
      const [cols] = await prodPool.query(`SHOW COLUMNS FROM stock_entries`);
      const texto = cols.filter(c => /char|text|varchar/i.test(String(c.Type || c.type || '')))
        .map(c => String(c.Field || c.field));
      const re = /(import|refer|ref|doc|gu[ií]a|guide|comprob|nota|note|code|c[oó]digo)/i;
      const cand = texto.filter(n => re.test(n));
      _refCols = (cand.length ? cand : texto).slice(0, 12); // límite de seguridad
    } catch (e) { _refCols = []; }
    return _refCols;
  }
  app.post('/api/importacion/erp-subidas', authAdmin, mImp, async (req, res) => {
    try {
      const refs = Array.isArray(req.body && req.body.refs)
        ? [...new Set(req.body.refs.map(s => String(s || '').trim()).filter(Boolean))] : [];
      if (!refs.length) return res.json({});
      const cols = await columnasRefEntries();
      if (!cols.length) return res.json({});
      const where = cols.map(c => '`' + c + '` IN (?)').join(' OR ');
      const args = cols.map(() => refs);
      const sel = cols.map(c => '`' + c + '`').join(', ');
      const [rows] = await prodPool.query(
        `SELECT id, ${sel} FROM stock_entries WHERE ${where} ORDER BY id DESC LIMIT 2000`, args);
      const refSet = new Set(refs.map(r => r.toUpperCase()));
      const out = {}; // ref -> { subida:true, entry_id }
      rows.forEach(row => {
        for (const c of cols) {
          const v = row[c]; if (v == null) continue;
          const val = String(v).trim().toUpperCase();
          if (refSet.has(val) && !out[val]) out[val] = { subida: true, entry_id: row.id, campo: c };
        }
      });
      // Devolver con la clave EXACTA que mandó el cliente
      const resp = {};
      refs.forEach(r => { const hit = out[r.toUpperCase()]; if (hit) resp[r] = hit; });
      res.json(resp);
    } catch (e) {
      console.error('[importacion] erp-subidas', e.message);
      res.status(500).json({ error: 'No se pudo verificar el ERP' });
    }
  });

  return { prepararTablas };
};
