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

const { rutaCatalogo } = require('./comunes');

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
    // Memoria de asignaciones "proveedor + código de factura → SKU". Se llena con
    // lo que TÚ eliges a mano y, sobre todo, con lo que el ALMACÉN confirma con el
    // producto en la mano. La próxima factura con ese código sale "ya confirmado".
    await portalPool.query(`
      CREATE TABLE IF NOT EXISTS imp_sku_mem (
        k          VARCHAR(200) PRIMARY KEY,
        sku        VARCHAR(120) NOT NULL DEFAULT '',
        fuente     VARCHAR(20)  NOT NULL DEFAULT '',
        veces      INT NOT NULL DEFAULT 1,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )`);
  }

  // ── Memoria SKU: clave = PROVEEDOR|CÓDIGO (solo letras y números, mayúsculas) ─
  //    El frontend arma la MISMA clave (memKey en importacion.html).
  const limpio = (v) => String(v == null ? '' : v).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().replace(/[^A-Z0-9]/g, '');
  const memKey = (prov, codigo) => {
    const p = limpio(String(prov || '').split('(')[0]), c = limpio(codigo);
    return (p && c) ? (p + '|' + c).slice(0, 200) : '';
  };
  // entries: [{prov, codigo, sku}] · fuente: 'maestro' | 'almacen'
  // Lo que confirmó el ALMACÉN no lo pisa una elección posterior del maestro
  // (el almacén vio el producto); una nueva confirmación del almacén sí lo actualiza.
  async function aprenderSku(entries, fuente) {
    const vistos = new Map();
    (Array.isArray(entries) ? entries : []).forEach(e => {
      const k = memKey(e && e.prov, e && e.codigo);
      const sku = String((e && e.sku) || '').trim().slice(0, 120);
      if (k && sku) vistos.set(k, sku);
    });
    if (!vistos.size) return 0;
    const f = fuente === 'almacen' ? 'almacen' : 'maestro';
    const valores = [...vistos].map(([k, sku]) => [k, sku, f]);
    await portalPool.query(
      `INSERT INTO imp_sku_mem (k, sku, fuente) VALUES ?
       ON DUPLICATE KEY UPDATE
         sku    = IF(fuente = 'almacen' AND VALUES(fuente) <> 'almacen', sku, VALUES(sku)),
         fuente = IF(fuente = 'almacen' AND VALUES(fuente) <> 'almacen', fuente, VALUES(fuente)),
         veces  = veces + 1`, [valores]);
    return valores.length;
  }
  // Aprende de una recepción CONFIRMADA por el almacén (llamado desde recepciones).
  async function aprenderDeRecepcion(row) {
    if (!row) return;
    const items = asJson(row.items, []) || [];
    const entries = items
      .filter(i => !i.es_extra && i.codigo && i.sku_confirmado && i.estado_item !== 'no_llego' && !(i.sub && i.sub.length))
      .map(i => ({ prov: row.proveedor, codigo: i.codigo, sku: i.sku_confirmado }));
    try { await aprenderSku(entries, 'almacen'); }
    catch (e) { console.error('[importacion] aprender de recepción', e.message); }
  }

  // Helper: parsea JSON que puede venir como string o ya como objeto (mysql2 con
  // columnas JSON a veces devuelve el objeto ya parseado).
  const asJson = (v, fallback) => {
    if (v == null) return fallback;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch (e) { return fallback; }
  };

  // ── 1) CATÁLOGO (solo lectura, desde Renzo) → [[sku, name], ...] ───────────
  //    Excluye 'variable' (productos padre) y borrados. Caché COMPARTIDA con
  //    Recepciones y Seguimiento (comunes.js): una sola consulta cada 10 min.
  app.get('/api/importacion/catalogo', authAdmin, mImp, rutaCatalogo(prodPool, 'importacion'));

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

  // ── 3b) MEMORIA SKU (proveedor|código → sku) ──────────────────────────────
  //    GET → { clave: [sku, fuente] }  ·  POST { entries:[{prov,codigo,sku}] }
  app.get('/api/importacion/sku-mem', authAdmin, mImp, async (req, res) => {
    try {
      const [rows] = await portalPool.query(`SELECT k, sku, fuente FROM imp_sku_mem`);
      const out = {}; rows.forEach(r => { out[r.k] = [r.sku, r.fuente]; });
      res.json(out);
    } catch (e) {
      console.error('[importacion] get sku-mem', e.message);
      res.status(500).json({ error: 'No se pudo leer la memoria de SKU' });
    }
  });

  app.post('/api/importacion/sku-mem', authAdmin, mImp, async (req, res) => {
    try {
      const n = await aprenderSku(req.body && req.body.entries, 'maestro');
      res.json({ ok: true, n });
    } catch (e) {
      console.error('[importacion] post sku-mem', e.message);
      res.status(500).json({ error: 'No se pudo guardar la memoria de SKU' });
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
      const { model, prompt, pdf_base64, pdfs_base64 } = req.body || {};
      // Acepta un solo PDF (pdf_base64) o VARIOS (pdfs_base64: array). Se usa
      // para leer con IA la Consulta de Declaración + Consulta de Series (courier
      // por empresa privada, sin reporte de DUA descargable) en una sola llamada.
      const pdfs = (Array.isArray(pdfs_base64) && pdfs_base64.length)
        ? pdfs_base64.filter(Boolean)
        : (pdf_base64 ? [pdf_base64] : []);
      if (!prompt || !pdfs.length) return res.status(400).json({ error: 'Falta el prompt o el PDF' });
      const mdl = (model || 'gemini-3.6-flash').replace(/[^a-zA-Z0-9.\-]/g, '');

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${mdl}:generateContent?key=${encodeURIComponent(key)}`;
      const body = {
        contents: [{ parts: [
          ...pdfs.map(d => ({ inline_data: { mime_type: 'application/pdf', data: d } })),
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

  // ── ¿Ya se subió al ERP? El código de importación (Ref. importación) puede
  //    estar en cualquier tabla de Renzo (ingreso, compra, etc.). En vez de
  //    adivinar la tabla, se descubre sola vía information_schema: columnas de
  //    texto cuyo nombre sugiere "importación" o "referencia", y se busca ahí.
  //    SOLO LECTURA.
  let _refPlan = null;
  // Celda CONFIRMADA donde Renzo guarda la "Ref. importación" (verificada en la
  // base): stock_entries.importacion_ref. Se busca SOLO aquí — una consulta rápida
  // y barata, sin escanear todo el esquema (eso era lento y encarecía Railway).
  const REF_FIJA = { t: 'stock_entries', c: 'importacion_ref' };
  async function planImportRef() {
    return [REF_FIJA];
  }
  // Caché por referencia (positivos y negativos) para no golpear el ERP en cada
  // render. TTL corto: si subes un ingreso, se refleja en pocos minutos.
  const _erpCache = new Map(); // refUpper -> { hit:{...}|null, at }
  const ERP_TTL = 5 * 60 * 1000;
  app.post('/api/importacion/erp-subidas', authAdmin, mImp, async (req, res) => {
    try {
      const refs = Array.isArray(req.body && req.body.refs)
        ? [...new Set(req.body.refs.map(s => String(s || '').trim()).filter(Boolean))] : [];
      if (!refs.length) return res.json({});
      const now = Date.now();
      const resp = {};
      const need = [];
      refs.forEach(r => {
        const c = _erpCache.get(r.toUpperCase());
        if (c && (now - c.at) < ERP_TTL) { if (c.hit) resp[r] = c.hit; }
        else need.push(r);
      });
      if (need.length) {
        const plan = await planImportRef();
        const upper = need.map(r => r.toUpperCase());
        const found = {}; // refExacto -> hit
        if (plan.length) {
          for (const { t, c } of plan) {
            try {
              const [rows] = await prodPool.query(
                'SELECT `' + c + '` AS ref, id FROM `' + t + '` WHERE `' + c + '` IN (?) LIMIT 500', [need]);
              rows.forEach(row => {
                const val = String(row.ref == null ? '' : row.ref).trim().toUpperCase();
                const i = upper.indexOf(val);
                if (i >= 0 && !found[need[i]]) found[need[i]] = { subida: true, entry_id: row.id, tabla: t, campo: c };
              });
            } catch (e) { /* la tabla puede no tener 'id' u otra cosa: se ignora */ }
            if (Object.keys(found).length === need.length) break;
          }
        }
        need.forEach(r => { const hit = found[r] || null; _erpCache.set(r.toUpperCase(), { hit, at: now }); if (hit) resp[r] = hit; });
      }
      res.json(resp);
    } catch (e) {
      console.error('[importacion] erp-subidas', e.message);
      res.status(500).json({ error: 'No se pudo verificar el ERP' });
    }
  });

  // ── Diagnóstico: identificar en qué TABLA/COLUMNA del ERP vive la Ref.
  //    importación. Devuelve los candidatos y dónde se encontró cada ref.
  app.post('/api/importacion/erp-diag', authAdmin, mImp, async (req, res) => {
    try {
      const refs = Array.isArray(req.body && req.body.refs)
        ? [...new Set(req.body.refs.map(s => String(s || '').trim()).filter(Boolean))] : [];
      const plan = await planImportRef();
      const candidatos = plan.map(p => p.t + '.' + p.c);
      const hallazgos = {};
      const upper = refs.map(r => r.toUpperCase());
      for (const { t, c } of plan) {
        if (!refs.length) break;
        try {
          const [rows] = await prodPool.query(
            'SELECT `' + c + '` AS ref, id FROM `' + t + '` WHERE `' + c + '` IN (?) LIMIT 500', [refs]);
          rows.forEach(row => {
            const val = String(row.ref == null ? '' : row.ref).trim().toUpperCase();
            const i = upper.indexOf(val);
            if (i >= 0 && !hallazgos[refs[i]]) hallazgos[refs[i]] = { tabla: t, campo: c, id: row.id };
          });
        } catch (e) { /* ignora */ }
      }
      res.json({ candidatos, hallazgos });
    } catch (e) {
      console.error('[importacion] erp-diag', e.message);
      res.status(500).json({ error: 'No se pudo diagnosticar el ERP' });
    }
  });

  return { prepararTablas, aprenderDeRecepcion };
};
