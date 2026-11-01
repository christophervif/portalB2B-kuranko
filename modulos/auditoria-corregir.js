// ═══════════════════════════════════════════════════════════════════════════
//  MÓDULO: Auditoría de catálogo → "Corregir en el ERP" (write-back)
//  Antes vivía en modulos/sincronizacion.js (tarjeta en Sistemas → Sincronización
//  web). Ahora es una pestaña de public/auditoria.html. Mismas rutas de siempre.
//
//  GET  /admin/erp-writeback-preview  → SOLO LECTURA. Cambios propuestos:
//        1) Vincular WooCommerce ID por SKU (está en la web, el ERP lo tiene vacío).
//        2) Reservas de agotados con 'yes' (permitir): sugerido 'notify', salvo marketplace y
//           packs (MKP / PCK en SKU o nombre) → 'no'. El usuario puede cambiar el valor por fila.
//        3) Imágenes: link del ERP que NO es de kuranko → link de kuranko (de la web), y para lo
//           que YA está en la web (con ID) y en el ERP no tiene ninguna imagen de kuranko: se
//           consultan sus imágenes en WooCommerce (WC_URL/KEY/SECRET) → reemplazar y/o AGREGAR
//           (INSERT en product_images como el importador: disk 'external').
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
      imagenes.push({ sku: w.sku || s, img_id: noK.img_id, actual: noK.path, nuevo: faltan[i], antes: noK.path, despues: faltan[i],
        nivel: 'producto', accion: 'reemplazar', accion_txt: 'Reemplazar' }));
  });

  const reservas = d.backs.map(c => {
    const mkp = /MKP|PCK/i.test(`${c.sku || ''} ${c.nombre || ''} ${c.producto || ''}`);
    const sug = mkp ? 'no' : 'notify';
    return { sku: c.sku, vid: c.vid, tipo: c.tipo, nombre: c.nombre || c.producto || '', mkp,
      antes: 'permitir (yes)', sugerido: sug, nuevo: sug, despues: sug,
      motivo: mkp ? 'Marketplace / pack: sin reservas' : 'Avisar al cliente (A PEDIDO)' };
  });
  return { vincularId, idConflicto, reservas, imagenes };
}


// ─── Imágenes desde la web para productos YA vinculados (puro) ───────────────
//  objetivos: [{nivel:'producto'|'variacion', pid, vid|null, wc, sku, nombre, erp:[{id,path,sort_order}]}]
//  web: { 'p:<wc>': {sku, imgs:[url]}, 'v:<wc>': {sku, imgs:[url]} }
//  Si el ERP no tiene ninguna imagen de kuranko en ese nivel y la web sí: los links que no
//  son de kuranko se REEMPLAZAN (en orden) y las imágenes que falten se AGREGAN.
function propuestasImagenesWeb(objetivos, web, maxAgregar = 8) {
  const out = [], avisos = [];
  for (const o of objetivos) {
    if (o.erp.some(e => esKuranko(e.path))) continue;
    const w = web[(o.nivel === 'producto' ? 'p:' : 'v:') + o.wc];
    if (!w) continue;
    if (w.sku && o.sku && k(w.sku) !== k(o.sku)) { avisos.push(`${o.sku}: en la web el ID ${o.wc} tiene el SKU "${w.sku}"; no se copian sus imágenes.`); continue; }
    const imgs = [...new Set((w.imgs || []).filter(esKuranko))];
    if (!imgs.length) continue;
    const viejas = o.erp.slice().sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id);
    const base = { sku: o.sku, nombre: o.nombre, nivel: o.nivel, pid: o.pid, vid: o.vid };
    viejas.slice(0, imgs.length).forEach((v, i) => out.push({ ...base, img_id: v.id, actual: v.path, nuevo: imgs[i],
      antes: v.path, despues: imgs[i], accion: 'reemplazar', accion_txt: 'Reemplazar' }));
    const maxSort = viejas.reduce((m, v) => Math.max(m, Number(v.sort_order) || 0), -1);
    imgs.slice(viejas.length, viejas.length + maxAgregar).forEach((u, i) => out.push({ ...base, img_id: null, actual: '(sin imagen)',
      nuevo: u, antes: '', despues: u, accion: 'agregar', accion_txt: viejas.length ? 'Agregar' : 'Agregar (no tenía)',
      sort_order: maxSort + 1 + i, is_primary: !viejas.length && i === 0 ? 1 : 0 }));
  }
  return { imagenes: out, avisos };
}

module.exports = function registrarCorregirErp({ app, authAdmin, prodPool, portalPool, erpWritePool }) {
  // Acceso: auditoría o sincronización (el maestro siempre pasa)
  const permite = (req, res, next) => {
    const a = req.admin || {};
    if (a.maestro || (Array.isArray(a.modulos) && (a.modulos.includes('auditoria') || a.modulos.includes('sync')))) return next();
    return res.status(403).json({ error: 'No tienes acceso a este módulo' });
  };


  // ── WooCommerce (mismas variables que Promociones): imágenes de lo que ya está en la web ──
  const WC_URL = String(process.env.WC_URL || '').trim().replace(/\/+$/, '');
  const WC_AUTH = process.env.WC_CONSUMER_KEY && process.env.WC_CONSUMER_SECRET
    ? 'Basic ' + Buffer.from(`${process.env.WC_CONSUMER_KEY}:${process.env.WC_CONSUMER_SECRET}`).toString('base64') : null;
  const MAX_PADRES = 400;                 // padres variables consultados por vista previa
  const cacheWeb = new Map();             // clave → {t, val}; 30 min
  const TTL = 30 * 60e3;
  async function wcGet(ruta) {
    const r = await fetch(`${WC_URL}/wp-json/wc/v3${ruta}`, { headers: { Authorization: WC_AUTH }, signal: AbortSignal.timeout(30e3) });
    const d = await r.json().catch(() => null);
    if (!r.ok) throw new Error(`WooCommerce HTTP ${r.status}${d && d.message ? ' ' + d.message : ''}`.slice(0, 160));
    return d;
  }
  async function enParalelo(items, n, fn) {
    let i = 0; const corre = async () => { while (i < items.length) { const x = items[i++]; await fn(x); } };
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, corre));
  }
  async function imagenesDesdeWeb() {
    if (!WC_URL || !WC_AUTH || typeof fetch !== 'function') return { imagenes: [], avisos: ['No se consultaron las imágenes de la web: faltan WC_URL / WC_CONSUMER_KEY / WC_CONSUMER_SECRET en Railway.'] };
    const q = (sql, a) => prodPool.query(sql, a).then(r => r[0]);
    const prods = await q(`SELECT p.id AS pid, p.name, TRIM(COALESCE(NULLIF(p.sku_base,''), dv.sku)) AS sku,
              COALESCE(p.woocommerce_id, dv.woocommerce_id) AS wc
         FROM products p
         LEFT JOIN product_variations dv ON dv.id = (SELECT x.id FROM product_variations x WHERE x.product_id = p.id AND x.deleted_at IS NULL
                AND x.product_type IN ('variable','simple') ORDER BY x.woocommerce_id IS NULL, x.is_default DESC, x.id LIMIT 1)
        WHERE p.deleted_at IS NULL AND COALESCE(p.woocommerce_id, dv.woocommerce_id) IS NOT NULL`);
    const vars = await q(`SELECT pv.id AS vid, pv.product_id AS pid, TRIM(pv.sku) AS sku, pv.name, pv.woocommerce_id AS wc
         FROM product_variations pv WHERE pv.deleted_at IS NULL AND pv.product_type = 'variation' AND pv.woocommerce_id IS NOT NULL`);
    const imgs = await q(`SELECT id, product_id, product_variation_id, path, sort_order FROM product_images WHERE deleted_at IS NULL`);
    const porProd = {}, porVar = {};
    imgs.forEach(im => { if (im.product_variation_id != null) (porVar[im.product_variation_id] = porVar[im.product_variation_id] || []).push(im);
                         else if (im.product_id != null) (porProd[im.product_id] = porProd[im.product_id] || []).push(im); });
    const prodPorId = {}; prods.forEach(p => prodPorId[p.pid] = p);
    // Simple: cuenta también la imagen guardada en su variación
    const simples = await q(`SELECT product_id AS pid, id AS vid FROM product_variations WHERE deleted_at IS NULL AND product_type = 'simple'`);
    const extraSimple = {}; simples.forEach(x => (extraSimple[x.pid] = extraSimple[x.pid] || []).push(...(porVar[x.vid] || [])));
    const objetivos = [];
    prods.forEach(p => objetivos.push({ nivel: 'producto', pid: p.pid, vid: null, wc: p.wc, sku: p.sku, nombre: p.name,
      erp: porProd[p.pid] || [], conKuranko: (extraSimple[p.pid] || []).some(e => esKuranko(e.path)) }));
    vars.forEach(v => { const p = prodPorId[v.pid]; if (p) objetivos.push({ nivel: 'variacion', pid: v.pid, vid: v.vid, wc: v.wc, padreWc: p.wc,
      sku: v.sku, nombre: v.name, erp: porVar[v.vid] || [] }); });
    const faltan = objetivos.filter(o => !o.conKuranko && !o.erp.some(e => esKuranko(e.path)));
    // Consultar la web solo para lo que falta (con caché)
    const web = {}, avisos = [], ahora = Date.now();
    const desdeCache = key => { const c = cacheWeb.get(key); if (c && ahora - c.t < TTL) { if (c.val) web[key] = c.val; return true; } return false; };
    const prodIds = [...new Set(faltan.filter(o => o.nivel === 'producto').map(o => o.wc))].filter(id => !desdeCache('p:' + id));
    for (let i = 0; i < prodIds.length; i += 100) {
      const lote = prodIds.slice(i, i + 100);
      try {
        const d = await wcGet(`/products?include=${lote.join(',')}&per_page=100&_fields=id,sku,images`);
        const vistos = new Set();
        (d || []).forEach(x => { vistos.add(x.id); const val = { sku: x.sku, imgs: (x.images || []).map(m => m.src).filter(Boolean) }; web['p:' + x.id] = val; cacheWeb.set('p:' + x.id, { t: ahora, val }); });
        lote.filter(id => !vistos.has(Number(id))).forEach(id => cacheWeb.set('p:' + id, { t: ahora, val: null }));
      } catch (e) { avisos.push('No se pudo leer productos de la web: ' + e.message); break; }
    }
    let padres = [...new Set(faltan.filter(o => o.nivel === 'variacion').map(o => o.padreWc))].filter(id => !desdeCache('vp:' + id));
    if (padres.length > MAX_PADRES) { avisos.push(`Se revisaron ${MAX_PADRES} productos variables de ${padres.length}; vuelve a cargar para seguir con el resto.`); padres = padres.slice(0, MAX_PADRES); }
    await enParalelo(padres, 4, async pw => {
      try {
        for (let page = 1; page < 20; page++) {
          const d = await wcGet(`/products/${pw}/variations?per_page=100&page=${page}&_fields=id,sku,image`);
          (d || []).forEach(x => { const val = { sku: x.sku, imgs: x.image && x.image.src ? [x.image.src] : [] }; web['v:' + x.id] = val; cacheWeb.set('v:' + x.id, { t: ahora, val }); });
          if (!d || d.length < 100) break;
        }
        cacheWeb.set('vp:' + pw, { t: ahora, val: true });
      } catch (e) { if (avisos.length < 5) avisos.push(`Variaciones del producto web ${pw}: ${e.message}`); }
    });
    // las variaciones ya leídas en cachés anteriores
    faltan.filter(o => o.nivel === 'variacion').forEach(o => desdeCache('v:' + o.wc));
    const r = propuestasImagenesWeb(faltan, web);
    return { imagenes: r.imagenes, avisos: avisos.concat(r.avisos) };
  }

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
        `SELECT pv.id AS vid, TRIM(pv.sku) AS sku, pv.product_type AS tipo, pv.name AS nombre, p.name AS producto
           FROM product_variations pv
           JOIN products p ON p.id = pv.product_id
           JOIN product_variation_stocks pvs ON pvs.product_variation_id = pv.id
          WHERE pv.deleted_at IS NULL AND pvs.backorder_mode = 'yes'
          GROUP BY pv.id, TRIM(pv.sku), pv.product_type, pv.name, p.name`);

      const base = calcularPropuestas({ web, erpVar, wcEnUso, imgs, backs });
      // Imágenes de productos que YA están en la web (el puente solo recolecta los que no tienen ID)
      let avisosImg = [];
      if (req.query.imagenes !== '0') {
        const iw = await imagenesDesdeWeb();
        const ya = new Set(base.imagenes.map(x => x.img_id).filter(Boolean));
        base.imagenes = base.imagenes.concat(iw.imagenes.filter(x => !x.img_id || !ya.has(x.img_id)));
        avisosImg = iw.avisos;
      }
      res.json({
        ...base, avisos_imagenes: avisosImg,
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
            if (!['no', 'notify'].includes(c.nuevo)) { errores.push({ ref: c.sku || c.vid, error: `Valor de reservas no válido: ${c.nuevo}` }); continue; }
            c.despues = c.nuevo;
            [r] = await pool.query(
              `UPDATE product_variation_stocks SET backorder_mode = ?
                WHERE product_variation_id = ? AND backorder_mode = 'yes'`, [c.nuevo, c.vid]);
          } else if (c.tipo === 'img' && c.accion === 'agregar') {
            if (!esKuranko(c.nuevo)) { errores.push({ ref: c.sku, error: 'El link nuevo no es de kuranko.pe' }); continue; }
            const pid = c.vid ? null : Number(c.pid), vid = c.vid ? Number(c.vid) : null;
            if (!(pid > 0) && !(vid > 0)) { errores.push({ ref: c.sku, error: 'Producto no válido' }); continue; }
            // Igual que el importador del ERP: URL completa, disk 'external'; no repite el mismo link
            [r] = await pool.query(
              `INSERT INTO product_images (product_id, product_variation_id, path, disk, alt_text, sort_order, is_primary, created_at, updated_at)
               SELECT ?, ?, ?, 'external', ?, ?, ?, NOW(), NOW() FROM DUAL
                WHERE NOT EXISTS (SELECT 1 FROM product_images WHERE deleted_at IS NULL AND path = ?
                                     AND product_id <=> ? AND product_variation_id <=> ?)`,
              [pid, vid, c.nuevo, String(c.nombre || '').slice(0, 250), Number(c.sort_order) || 0, c.is_primary ? 1 : 0, c.nuevo, pid, vid]);
            c.vid = vid || ''; c.img_id = '';
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

module.exports._test = { calcularPropuestas, propuestasImagenesWeb, esKuranko };
