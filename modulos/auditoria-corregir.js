// ═══════════════════════════════════════════════════════════════════════════
//  MÓDULO: Auditoría de catálogo → "Corregir en el ERP" (write-back)
//  Antes vivía en modulos/sincronizacion.js (tarjeta en Sistemas → Sincronización
//  web). Ahora es una pestaña de public/auditoria.html. Mismas rutas de siempre.
//
//  GET  /admin/erp-writeback-preview  → SOLO LECTURA. Cambios propuestos:
//        1) Vincular WooCommerce ID por SKU (está en la web, el ERP lo tiene vacío).
//        2) Reservas de agotados: backorder_mode 'yes' (permitir) → 'notify'.
//        3) Imágenes: link del ERP que NO es de kuranko → link de kuranko (de la web).
//  POST /admin/erp-writeback-aplicar  → escribe SOLO lo seleccionado con la cuenta
//        de escritura del portal (ERP_ESCRITURA_URL). Cada UPDATE re-verifica su
//        condición (idempotente) y queda registrado en sync_erp_writeback_log.
//
//  Permiso: 'auditoria' o 'sync' (antes solo 'sync'; así nadie pierde el acceso).
//  Fuente de "lo que hay en la web": tabla sync_pendientes_web que llena el puente.
// ═══════════════════════════════════════════════════════════════════════════

const esKuranko = u => /kuranko\.pe/i.test(String(u || ''));
const k = s => String(s || '').trim().toLowerCase();

// ─── Cálculo puro (sin base de datos) — exportado para pruebas ──────────────
//  d = { web:[{sku,woocommerce_id,imagenes}], erpVar:[{vid,pid,sku,tipo,wc_id}],
//        wcEnUso:[{wc_id,vid,sku}],  imgs:[{id,product_id,product_variation_id,path}],
//        backs:[{vid,sku,tipo}] }
function calcularPropuestas(d) {
  const webPorSku = {};
  d.web.forEach(w => { if (w.woocommerce_id) webPorSku[k(w.sku)] = w; });

  // ID ya usado por OTRA variación del ERP → no se propone (crearía un ID duplicado,
  // que es una alerta crítica de la auditoría y hace que el puente pise un producto con otro).
  const usoWc = {};
  d.wcEnUso.forEach(r => { (usoWc[String(r.wc_id)] = usoWc[String(r.wc_id)] || []).push(r); });
  const yaPropuesto = {};

  const vincularId = [], idConflicto = [];
  d.erpVar.forEach(r => {
    if (r.wc_id != null) return;
    const w = webPorSku[k(r.sku)];
    if (!w) return;
    const id = String(w.woocommerce_id);
    const otros = (usoWc[id] || []).filter(x => x.vid !== r.vid);
    if (otros.length) { idConflicto.push({ sku: r.sku, tipo: r.tipo, nuevo: id, motivo: `El ID ${id} ya lo tiene ${otros.map(o => o.sku || ('#' + o.vid)).join(', ')}` }); return; }
    if (yaPropuesto[id]) { idConflicto.push({ sku: r.sku, tipo: r.tipo, nuevo: id, motivo: `SKU repetido en el ERP: el ID ${id} ya se propone para otra fila (${yaPropuesto[id]})` }); return; }
    yaPropuesto[id] = r.sku;
    vincularId.push({ sku: r.sku, vid: r.vid, pid: r.pid, ptipo: r.tipo, tipo: r.tipo, nuevo: w.woocommerce_id, antes: '(vacío)', despues: id });
  });

  // Imágenes del ERP agrupadas por SKU: las que ya son de kuranko y las que no
  const vidToSku = {}, pidToSkus = {};
  d.erpVar.forEach(r => { vidToSku[r.vid] = r.sku; (pidToSkus[r.pid] = pidToSkus[r.pid] || []).push(r.sku); });
  const erpImg = {};
  d.imgs.forEach(im => {
    if (!im.path) return;
    let sku = null;
    if (im.product_variation_id != null && vidToSku[im.product_variation_id]) sku = vidToSku[im.product_variation_id];
    else if (im.product_id != null && pidToSkus[im.product_id]) sku = pidToSkus[im.product_id][0];
    if (!sku) return;
    const e = erpImg[k(sku)] = erpImg[k(sku)] || { kuranko: new Set(), noKuranko: [] };
    if (esKuranko(im.path)) e.kuranko.add(im.path.trim()); else e.noKuranko.push({ img_id: im.id, path: im.path });
  });
  // Cada link NO-kuranko se reemplaza por una imagen kuranko de la web que el ERP aún no tenga
  const imagenes = [];
  Object.keys(erpImg).forEach(s => {
    const e = erpImg[s], w = webPorSku[s];
    if (!e.noKuranko.length || !w || !w.imagenes) return;
    const faltan = String(w.imagenes).split(',').map(x => x.trim()).filter(x => esKuranko(x) && !e.kuranko.has(x));
    e.noKuranko.slice(0, faltan.length).forEach((noK, i) =>
      imagenes.push({ sku: w.sku || s, img_id: noK.img_id, actual: noK.path, nuevo: faltan[i], antes: noK.path, despues: faltan[i] }));
  });

  const reservas = d.backs.map(c => ({ sku: c.sku, vid: c.vid, tipo: c.tipo, antes: 'permitir (yes)', despues: 'notify' }));
  return { vincularId, idConflicto, reservas, imagenes };
}

module.exports = function registrarCorregirErp({ app, authAdmin, prodPool, portalPool, erpWritePool }) {
  // Acceso: auditoría o sincronización (el maestro siempre pasa)
  const permite = (req, res, next) => {
    const a = req.admin || {};
    if (a.maestro || (Array.isArray(a.modulos) && (a.modulos.includes('auditoria') || a.modulos.includes('sync')))) return next();
    return res.status(403).json({ error: 'No tienes acceso a este módulo' });
  };

  app.get('/admin/erp-writeback-preview', authAdmin, permite, async (req, res) => {
    try {
      let web = [], recolectadoEn = null;
      try {
        const [w] = await portalPool.query(
          `SELECT TRIM(sku) AS sku, woocommerce_id, imagenes FROM sync_pendientes_web WHERE woocommerce_id IS NOT NULL`);
        web = w;
        const [[ts]] = await portalPool.query(`SELECT corrio_en FROM sync_pendientes_web_ts WHERE id = 1`);
        recolectadoEn = ts ? ts.corrio_en : null;
      } catch (e) { /* el puente aún no recolectó */ }

      const skus = [...new Set(web.map(w => k(w.sku)).filter(Boolean))];
      const ids = [...new Set(web.map(w => w.woocommerce_id).filter(Boolean))];
      let erpVar = [], wcEnUso = [], imgs = [];
      if (skus.length) {
        [erpVar] = await prodPool.query(
          `SELECT pv.id AS vid, pv.product_id AS pid, TRIM(pv.sku) AS sku, pv.product_type AS tipo, pv.woocommerce_id AS wc_id
             FROM product_variations pv
            WHERE pv.deleted_at IS NULL AND LOWER(TRIM(pv.sku)) IN (?)`, [skus]);
      }
      if (ids.length) {
        [wcEnUso] = await prodPool.query(
          `SELECT woocommerce_id AS wc_id, id AS vid, TRIM(sku) AS sku
             FROM product_variations WHERE deleted_at IS NULL AND woocommerce_id IN (?)`, [ids]);
      }
      const vids = erpVar.map(r => r.vid), pids = [...new Set(erpVar.map(r => r.pid))];
      if (vids.length) {
        [imgs] = await prodPool.query(
          `SELECT id, product_id, product_variation_id, path FROM product_images
            WHERE deleted_at IS NULL AND (product_variation_id IN (?) OR product_id IN (?))`, [vids, pids]);
      }
      const [backs] = await prodPool.query(
        `SELECT pv.id AS vid, TRIM(pv.sku) AS sku, pv.product_type AS tipo
           FROM product_variations pv
           JOIN product_variation_stocks pvs ON pvs.product_variation_id = pv.id
          WHERE pv.deleted_at IS NULL AND pvs.backorder_mode = 'yes'
          GROUP BY pv.id, TRIM(pv.sku), pv.product_type`);

      res.json({
        ...calcularPropuestas({ web, erpVar, wcEnUso, imgs, backs }),
        recolectado_en: recolectadoEn,
        puede_aplicar: !!erpWritePool
      });
    } catch (e) { res.status(500).json({ error: 'Error al generar la vista previa: ' + e.message }); }
  });

  app.post('/admin/erp-writeback-aplicar', authAdmin, permite, async (req, res) => {
    try {
      const pool = erpWritePool;
      if (!pool) return res.status(400).json({ error: 'Falta configurar ERP_ESCRITURA_URL (cuenta portal_erp) en Railway.' });
      const cambios = Array.isArray(req.body && req.body.cambios) ? req.body.cambios : [];
      if (!cambios.length) return res.status(400).json({ error: 'No se seleccionó ningún cambio.' });
      try {
        await portalPool.query(`CREATE TABLE IF NOT EXISTS sync_erp_writeback_log (
          id INT AUTO_INCREMENT PRIMARY KEY, tipo VARCHAR(20), referencia VARCHAR(64),
          sku VARCHAR(255), antes MEDIUMTEXT, despues MEDIUMTEXT,
          aplicado_en DATETIME DEFAULT CURRENT_TIMESTAMP)`);
        await portalPool.query(`ALTER TABLE sync_erp_writeback_log ADD COLUMN usuario VARCHAR(100) NULL`).catch(() => {});
      } catch (e) { /* log opcional */ }
      const usuario = (req.admin && req.admin.usuario) || '';
      let aplicados = 0, sinCambio = 0; const errores = [];
      for (const c of cambios) {
        try {
          let r;
          if (c.tipo === 'id') {
            // Re-verifica al momento que el ID no lo tenga ya otra variación
            const [[otro]] = await pool.query(
              `SELECT id FROM product_variations WHERE woocommerce_id = ? AND id <> ? AND deleted_at IS NULL LIMIT 1`, [c.nuevo, c.vid]);
            if (otro) { errores.push({ ref: c.sku || c.vid, error: `El ID ${c.nuevo} ya lo tiene otra variación (#${otro.id})` }); continue; }
            [r] = await pool.query(
              `UPDATE product_variations SET woocommerce_id = ? WHERE id = ? AND woocommerce_id IS NULL`, [c.nuevo, c.vid]);
            // En SIMPLE y VARIABLE, llenar también products.woocommerce_id. En variación hija no.
            if ((c.ptipo === 'simple' || c.ptipo === 'variable') && c.pid) {
              try {
                await pool.query(`UPDATE products SET woocommerce_id = ? WHERE id = ? AND woocommerce_id IS NULL`, [c.nuevo, c.pid]);
              } catch (e) { /* falta GRANT UPDATE(woocommerce_id) ON products: la variación igual quedó */ }
            }
          } else if (c.tipo === 'back') {
            [r] = await pool.query(
              `UPDATE product_variation_stocks SET backorder_mode = 'notify'
                WHERE product_variation_id = ? AND backorder_mode = 'yes'`, [c.vid]);
          } else if (c.tipo === 'img') {
            if (!esKuranko(c.nuevo)) { errores.push({ ref: c.sku || c.img_id, error: 'El link nuevo no es de kuranko.pe' }); continue; }
            [r] = await pool.query(
              `UPDATE product_images SET path = ? WHERE id = ? AND path NOT LIKE '%kuranko.pe%'`, [c.nuevo, c.img_id]);
          } else continue;
          if (r && r.affectedRows > 0) {
            aplicados++;
            try {
              await portalPool.query(
                `INSERT INTO sync_erp_writeback_log (tipo, referencia, sku, antes, despues, usuario) VALUES (?,?,?,?,?,?)`,
                [c.tipo, String(c.vid || c.img_id || ''), c.sku || '', String(c.antes || '').slice(0, 2000), String(c.despues || '').slice(0, 2000), usuario]);
            } catch (e) { /* log opcional */ }
          } else sinCambio++;
        } catch (e) { errores.push({ ref: c.sku || c.vid || c.img_id || '', error: e.message }); }
      }
      res.json({ ok: true, aplicados, sin_cambio: sinCambio, errores });
    } catch (e) { res.status(500).json({ error: 'Error al aplicar: ' + e.message }); }
  });
};

module.exports._test = { calcularPropuestas, esKuranko };
