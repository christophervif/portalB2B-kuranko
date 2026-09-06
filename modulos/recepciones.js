// ═══════════════════════════════════════════════════════════════════════════
//  MÓDULO: Recepción de mercadería (paso intermedio entre Factura→SKU y DUA)
//
//  Idea: cuando una importación es COMPRA, el admin envía la carga detectada
//  (proveedor, empresa, N° factura e ítems, SIN PRECIOS) al almacén. El
//  supervisor (admin secundario con el módulo 'recepciones'), desde el celular:
//    1) elige a qué almacén ingresa,
//    2) valida el SKU sugerido de cada ítem contra el sistema,
//    3) marca si cuadra la cantidad (y cuánto llegó realmente).
//  Al confirmar, la recepción queda 'validada' y el admin la ve en el paso
//  intermedio de Importación para revisar/corregir y seguir a la DUA.
//
//  · SOLO LECTURA sobre el ERP (prodPool): lista de almacenes (locations).
//  · Todo lo demás se guarda en el portal (portalPool → imp_recepciones).
//  · El payload que ve el supervisor NUNCA incluye precios/costos.
//  Protegido con authAdmin + requiereModulo('recepciones') (el maestro pasa).
// ═══════════════════════════════════════════════════════════════════════════

module.exports = function registrarRecepciones({
  app, authAdmin, requiereModulo, prodPool, portalPool
}) {

  const mRec = requiereModulo('recepciones');

  async function prepararTablas() {
    await portalPool.query(`
      CREATE TABLE IF NOT EXISTS imp_recepciones (
        id             VARCHAR(40) PRIMARY KEY,
        importacion_id VARCHAR(40),
        proveedor      VARCHAR(255) NOT NULL DEFAULT '',
        empresa        VARCHAR(255) NOT NULL DEFAULT '',
        n_factura      VARCHAR(120) NOT NULL DEFAULT '',
        tipo           VARCHAR(20)  NOT NULL DEFAULT 'compra',
        estado         VARCHAR(20)  NOT NULL DEFAULT 'pendiente',
        almacen_id     INT NULL,
        almacen_nombre VARCHAR(255) NOT NULL DEFAULT '',
        almacen_codigo VARCHAR(80)  NOT NULL DEFAULT '',
        items          JSON NOT NULL,
        validado_por   VARCHAR(120) NOT NULL DEFAULT '',
        validado_en    DATETIME NULL,
        creado_en      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        actualizado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX (estado), INDEX (n_factura)
      )`);
    // Por si la tabla ya existía con id corto: ampliar para que quepa código + N° factura.
    try { await portalPool.query(`ALTER TABLE imp_recepciones MODIFY id VARCHAR(80)`); } catch (e) {}
    try { await portalPool.query(`ALTER TABLE imp_recepciones ADD COLUMN almacen_codigo VARCHAR(80) NOT NULL DEFAULT ''`); } catch (e) {}
    try { await portalPool.query(`ALTER TABLE imp_recepciones ADD COLUMN archivada TINYINT(1) NOT NULL DEFAULT 0`); } catch (e) {}
  }

  const asJson = (v, fb) => {
    if (v == null) return fb;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch (e) { return fb; }
  };
  const s = (v) => (v == null ? '' : String(v));
  const numOrNull = (v) => (v === '' || v == null || isNaN(Number(v))) ? null : Number(v);
  const quienEs = (req) => (req.admin && (req.admin.usuario || (req.admin.maestro ? 'maestro' : ''))) || '';

  // Solo campos permitidos del ítem que MANDA el admin (jamás precios/costos).
  function itemDeCarga(it) {
    return {
      codigo: s(it && it.codigo).slice(0, 120),
      desc: s(it && (it.desc || it.descripcion)).slice(0, 500),
      cantidad: numOrNull(it && it.cantidad),
      sku_sugerido: s(it && (it.sku_sugerido || it.sku)).slice(0, 120),
      confianza: s(it && it.confianza).slice(0, 20)  // exact|alta|rev|no|manual (nivel del match sugerido)
    };
  }
  // Campos que el supervisor añade/edita al validar (sin tocar cantidad de factura).
  function fusionarValidacion(base, val) {
    const v = val || {};
    return {
      codigo: base.codigo,
      desc: base.desc,
      cantidad: base.cantidad,                       // cantidad de la factura (no editable por almacén)
      sku_sugerido: base.sku_sugerido,
      confianza: s((base && base.confianza) || '').slice(0, 20),  // del match de la factura (no lo cambia el almacén)
      sku_confirmado: s(v.sku_confirmado || base.sku_confirmado || '').slice(0, 120),
      cuadra: (v.cuadra === true || v.cuadra === false) ? v.cuadra : (base.cuadra ?? null),
      cant_recibida: (v.cant_recibida !== undefined) ? numOrNull(v.cant_recibida) : (base.cant_recibida ?? null),
      estado_item: s(v.estado_item || base.estado_item || '').slice(0, 30), // ok|falta|sobra|no_llego|extra
      nota: s(v.nota || base.nota || '').slice(0, 300),
      es_extra: !!(v && v.es_extra) || !!(base && base.es_extra),
      // Subdivisión de una línea de factura en 2+ SKU (kit sin SKU único, o reparto de cantidad).
      // Cuenta como parte de la factura. modo: '' | 'precio' (kit) | 'cant' (reparto).
      split_modo: s((v && v.split_modo) || (base && base.split_modo) || '').slice(0, 10),
      sub: subLimpio((v && v.sub != null) ? v.sub : (base && base.sub))
    };
  }
  function subLimpio(arr) {
    if (!Array.isArray(arr)) return [];
    return arr.map(x => ({ sku_confirmado: s(x && x.sku_confirmado).slice(0, 120), cant_recibida: numOrNull(x && x.cant_recibida) }))
      .filter(x => x.sku_confirmado || x.cant_recibida != null);
  }
  // Ítem EXTRA: llegó y NO estaba en la factura. Lo agrega el almacenero.
  function itemExtra(v) {
    v = v || {};
    return {
      codigo: s(v.codigo).slice(0, 120),
      desc: s(v.desc || '(no estaba en la factura)').slice(0, 500),
      cantidad: null,                                  // no hay cantidad de factura
      sku_sugerido: '',
      sku_confirmado: s(v.sku_confirmado || '').slice(0, 120),
      cuadra: false,                                   // por definición es una diferencia
      cant_recibida: numOrNull(v.cant_recibida),
      estado_item: 'extra',
      nota: s(v.nota || '').slice(0, 300),
      es_extra: true
    };
  }

  // Resumen para las listas (sin exponer más de lo necesario)
  function resumen(row) {
    const items = asJson(row.items, []) || [];
    const conDif = items.filter(i => i.cuadra === false || ['falta', 'sobra', 'no_llego', 'extra'].includes(i.estado_item)).length;
    return {
      id: row.id, importacion_id: row.importacion_id || '',
      proveedor: row.proveedor, empresa: row.empresa, n_factura: row.n_factura,
      tipo: row.tipo, estado: row.estado,
      almacen_id: row.almacen_id, almacen_nombre: row.almacen_nombre, almacen_codigo: row.almacen_codigo || '',
      archivada: row.archivada ? 1 : 0,
      n_items: items.length, con_diferencias: conDif,
      validado_por: row.validado_por, validado_en: row.validado_en,
      creado_en: row.creado_en, actualizado_en: row.actualizado_en
    };
  }

  // ── Almacenes (del ERP, solo lectura) ──────────────────────────────────────
  // Detecta sola la columna de CÓDIGO de la tabla locations (code/codigo/…),
  // para poder mandar ese código como "destino" en el archivo de ingreso.
  let _almCol = null;
  async function colCodigoLocations() {
    if (_almCol !== null) return _almCol;
    try {
      const [cols] = await prodPool.query(`SHOW COLUMNS FROM locations`);
      const names = cols.map(c => String(c.Field || c.field || '').toLowerCase());
      _almCol = ['code', 'codigo', 'abbreviation', 'short_code', 'codigo_almacen', 'warehouse_code', 'sku'].find(c => names.includes(c)) || '';
    } catch (e) { _almCol = ''; }
    return _almCol;
  }
  let _almCache = null, _almAt = 0;
  const ALM_TTL = 10 * 60 * 1000;
  app.get('/api/recepcion/almacenes', authAdmin, mRec, async (req, res) => {
    try {
      if (_almCache && (Date.now() - _almAt) < ALM_TTL && !req.query.fresh) return res.json(_almCache);
      const col = await colCodigoLocations();
      const [rows] = await prodPool.query(
        `SELECT id, name, ${col ? '`' + col + '`' : 'NULL'} AS codigo, type FROM locations WHERE is_active = 1 ORDER BY name`);
      _almCache = rows.map(r => ({ id: r.id, nombre: r.name || '', codigo: r.codigo || '', tipo: r.type || '' }));
      _almAt = Date.now();
      res.json(_almCache);
    } catch (e) {
      console.error('[recepciones] almacenes', e.message);
      res.status(500).json({ error: 'No se pudo leer la lista de almacenes' });
    }
  });

  // ── Catálogo (solo lectura, para que el supervisor busque/corrija SKU) ─────
  //    El supervisor no tiene el módulo 'importaciones', así que expone aquí un
  //    catálogo liviano [[sku, name], ...] con caché de 10 min.
  let _catCache = null, _catAt = 0;
  const CAT_TTL = 10 * 60 * 1000;
  app.get('/api/recepcion/catalogo', authAdmin, mRec, async (req, res) => {
    try {
      if (_catCache && (Date.now() - _catAt) < CAT_TTL && !req.query.fresh) return res.json(_catCache);
      // Solo hijos (variation) y simples — los padres (variable) se excluyen.
      // El nombre es el del propio hijo/simple (no el del padre).
      const [rows] = await prodPool.query(`
        SELECT TRIM(sku) AS sku, name FROM product_variations
         WHERE product_type <> 'variable' AND deleted_at IS NULL
           AND sku IS NOT NULL AND TRIM(sku) <> '' ORDER BY sku`);
      _catCache = rows.map(r => [r.sku, r.name || '']);
      _catAt = Date.now();
      res.json(_catCache);
    } catch (e) {
      console.error('[recepciones] catalogo', e.message);
      res.status(500).json({ error: 'No se pudo leer el catálogo' });
    }
  });

  // ── Crear/actualizar una recepción desde el wizard (admin/maestro) ─────────
  //    Reenviar la misma factura ACTUALIZA la recepción (no duplica) mientras
  //    no esté 'validada'. Si ya está validada, se conserva y no se pisa.
  app.post('/api/recepcion', authAdmin, mRec, async (req, res) => {
    try {
      const b = req.body || {};
      if (!b.id) return res.status(400).json({ error: 'Falta el id de la recepción' });
      const itemsCarga = Array.isArray(b.items) ? b.items.map(itemDeCarga) : [];
      if (!itemsCarga.length) return res.status(400).json({ error: 'La carga no tiene ítems' });

      const [prev] = await portalPool.query(`SELECT items, estado FROM imp_recepciones WHERE id = ?`, [String(b.id)]);
      let items = itemsCarga;
      if (prev.length) {
        if (prev[0].estado === 'validada') {
          return res.status(409).json({ error: 'Esta recepción ya fue validada por el almacén; no se puede reenviar.' });
        }
        // Conservar lo que el supervisor ya haya adelantado (match por código+sku_sugerido)
        const antes = asJson(prev[0].items, []) || [];
        const clave = (i) => `${i.codigo}${i.sku_sugerido}`;
        const mapa = {}; antes.forEach(i => { mapa[clave(i)] = i; });
        items = itemsCarga.map(i => fusionarValidacion(i, mapa[clave(i)] || {}));
      } else {
        items = itemsCarga.map(i => fusionarValidacion(i, {}));
      }

      await portalPool.query(
        `INSERT INTO imp_recepciones (id, importacion_id, proveedor, empresa, n_factura, tipo, estado, items)
         VALUES (?,?,?,?,?,?, 'pendiente', ?)
         ON DUPLICATE KEY UPDATE importacion_id=VALUES(importacion_id), proveedor=VALUES(proveedor),
           empresa=VALUES(empresa), n_factura=VALUES(n_factura), tipo=VALUES(tipo), items=VALUES(items),
           estado = IF(estado='validada','validada','pendiente'), archivada = 0`,
        [String(b.id), s(b.importacion_id), s(b.proveedor), s(b.empresa), s(b.n_factura),
         s(b.tipo || 'compra'), JSON.stringify(items)]);
      res.json({ ok: true, id: String(b.id) });
    } catch (e) {
      console.error('[recepciones] crear', e.message);
      res.status(500).json({ error: 'No se pudo enviar a recepción' });
    }
  });

  // ── Listar recepciones ─────────────────────────────────────────────────────
  //    ?estado=pendiente|borrador|validada  · ?pendientes=1 (pendiente+borrador)
  app.get('/api/recepciones', authAdmin, mRec, async (req, res) => {
    try {
      let sql = `SELECT * FROM imp_recepciones`, args = [], w = [];
      if (req.query.estado) { w.push('estado = ?'); args.push(String(req.query.estado)); }
      if (req.query.pendientes) w.push(`estado IN ('pendiente','borrador')`);
      if (!req.query.incluir_archivadas) w.push('archivada = 0'); // ocultar las ya costeadas/archivadas
      if (w.length) sql += ' WHERE ' + w.join(' AND ');
      sql += ' ORDER BY (estado="validada") ASC, actualizado_en DESC';
      const [rows] = await portalPool.query(sql, args);
      res.json(rows.map(resumen));
    } catch (e) {
      console.error('[recepciones] listar', e.message);
      res.status(500).json({ error: 'No se pudieron leer las recepciones' });
    }
  });

  // Contador de pendientes (para el badge del panel)
  app.get('/api/recepciones/pendientes-count', authAdmin, mRec, async (req, res) => {
    try {
      const [[r]] = await portalPool.query(
        `SELECT COUNT(*) AS n FROM imp_recepciones WHERE estado IN ('pendiente','borrador')`);
      res.json({ n: r ? r.n : 0 });
    } catch (e) { res.json({ n: 0 }); }
  });

  // ── Ver una recepción completa ─────────────────────────────────────────────
  app.get('/api/recepcion/:id', authAdmin, mRec, async (req, res) => {
    try {
      const [rows] = await portalPool.query(`SELECT * FROM imp_recepciones WHERE id = ?`, [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: 'Recepción no encontrada' });
      const r = rows[0];
      res.json({ ...resumen(r), items: asJson(r.items, []) });
    } catch (e) {
      console.error('[recepciones] ver', e.message);
      res.status(500).json({ error: 'No se pudo leer la recepción' });
    }
  });

  // ── Validación del supervisor (guardar borrador o confirmar) ───────────────
  //    Body: { almacen_id, almacen_nombre, items:[{codigo,sku_sugerido,sku_confirmado,cuadra,cant_recibida,estado_item,nota}], confirmar }
  app.put('/api/recepcion/:id/validacion', authAdmin, mRec, async (req, res) => {
    try {
      const [rows] = await portalPool.query(`SELECT * FROM imp_recepciones WHERE id = ?`, [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: 'Recepción no encontrada' });
      const b = req.body || {};
      const base = asJson(rows[0].items, []) || [];
      // Emparejar por POSICIÓN (índice): el frontend manda los ítems no-extra en
      // el mismo orden que base. Antes se emparejaba por codigo+sku_sugerido, que
      // no es único (líneas repetidas o sin código) y colapsaba dos ítems en uno.
      const sent = Array.isArray(b.items) ? b.items : [];
      const noExtra = base.filter(i => !i.es_extra);
      const items = noExtra.map((it, k) => fusionarValidacion(it, sent[k] || {}));
      // Ítems EXTRA: el cliente manda la lista COMPLETA actual en b.extras.
      (Array.isArray(b.extras) ? b.extras : []).forEach(v => items.push(itemExtra(v)));

      const confirmar = !!b.confirmar;
      if (confirmar) {
        // Al confirmar exigimos almacén y un SKU confirmado por ítem (salvo los marcados 'no_llego'/'extra')
        if (!b.almacen_id) return res.status(400).json({ error: 'Elige el almacén de ingreso antes de confirmar.' });
        const faltan = items.filter(i => {
          if (i.estado_item === 'no_llego') return false;
          if (i.sub && i.sub.length) return i.sub.some(x => !x.sku_confirmado); // subdividido: cada sub-SKU
          return !i.sku_confirmado;
        });
        if (faltan.length) return res.status(400).json({ error: `Falta confirmar el SKU de ${faltan.length} ítem(s).` });
      }
      const estado = confirmar ? 'validada' : 'borrador';
      await portalPool.query(
        `UPDATE imp_recepciones SET almacen_id=?, almacen_nombre=?, almacen_codigo=?, items=?, estado=?,
           validado_por = IF(?, ?, validado_por), validado_en = IF(?, NOW(), validado_en)
         WHERE id = ?`,
        [numOrNull(b.almacen_id), s(b.almacen_nombre), s(b.almacen_codigo), JSON.stringify(items), estado,
         confirmar ? 1 : 0, quienEs(req), confirmar ? 1 : 0, req.params.id]);
      res.json({ ok: true, estado });
    } catch (e) {
      console.error('[recepciones] validar', e.message);
      res.status(500).json({ error: 'No se pudo guardar la validación' });
    }
  });

  // ── Corrección del maestro sobre una recepción validada (ajustar SKU) ──────
  //    Solo el maestro. Actualiza sku_confirmado / estado_item / cant_recibida.
  app.put('/api/recepcion/:id/correccion', authAdmin, mRec, async (req, res) => {
    try {
      if (!req.admin || !req.admin.maestro) return res.status(403).json({ error: 'Solo el maestro puede corregir la recepción.' });
      const [rows] = await portalPool.query(`SELECT * FROM imp_recepciones WHERE id = ?`, [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: 'Recepción no encontrada' });
      const b = req.body || {};
      const base = asJson(rows[0].items, []) || [];
      const sent = Array.isArray(b.items) ? b.items : [];
      // Emparejar por POSICIÓN, no por código: codigo+sku_sugerido no es único
      // (líneas repetidas o sin código) y por clave la corrección de un ítem
      // pisaba/perdía la de otro. Ambos frontends mandan la lista en el mismo
      // orden que base, así que el índice sí es estable.
      let items;
      if (Array.isArray(b.extras)) {
        // admin.html: items = solo no-extra, en orden; extras aparte.
        const noExtra = base.filter(i => !i.es_extra);
        items = noExtra.map((it, k) => fusionarValidacion(it, sent[k] || {}));
        b.extras.forEach(v => items.push(itemExtra(v)));
      } else {
        // importacion.html: items = lista COMPLETA (incluye extras), en orden.
        items = base.map((it, k) => fusionarValidacion(it, sent[k] || {}));
      }
      await portalPool.query(`UPDATE imp_recepciones SET items=? WHERE id=?`, [JSON.stringify(items), req.params.id]);
      res.json({ ok: true });
    } catch (e) {
      console.error('[recepciones] corregir', e.message);
      res.status(500).json({ error: 'No se pudo guardar la corrección' });
    }
  });

  // ── Archivar / desarchivar (se oculta de la lista cuando ya se costeó) ─────
  app.put('/api/recepcion/:id/archivar', authAdmin, mRec, async (req, res) => {
    try {
      const val = req.query.deshacer ? 0 : 1;
      await portalPool.query(`UPDATE imp_recepciones SET archivada=? WHERE id=?`, [val, req.params.id]);
      res.json({ ok: true, archivada: val });
    } catch (e) {
      console.error('[recepciones] archivar', e.message);
      res.status(500).json({ error: 'No se pudo archivar' });
    }
  });

  // ── Eliminar (solo maestro) ────────────────────────────────────────────────
  app.delete('/api/recepcion/:id', authAdmin, mRec, async (req, res) => {
    try {
      if (!req.admin || !req.admin.maestro) return res.status(403).json({ error: 'Solo el maestro puede eliminar.' });
      // No eliminar una recepción ya validada por el almacén (salvo ?force=1 explícito).
      if (!req.query.force) {
        const [rows] = await portalPool.query(`SELECT estado FROM imp_recepciones WHERE id = ?`, [req.params.id]);
        if (rows.length && rows[0].estado === 'validada') {
          return res.status(409).json({ error: 'No se puede eliminar: el almacén ya la validó.' });
        }
      }
      await portalPool.query(`DELETE FROM imp_recepciones WHERE id = ?`, [req.params.id]);
      res.json({ ok: true });
    } catch (e) {
      console.error('[recepciones] eliminar', e.message);
      res.status(500).json({ error: 'No se pudo eliminar' });
    }
  });

  return { prepararTablas };
};
