// ═══════════════════════════════════════════════════════════════════════════
//  MÓDULO: Catálogo B2B para las tiendas (portal del cliente)
//  La tienda ve en su portal un catálogo con: imagen, marca, SKU, nombre, PVP y su precio
//  (la imagen se agranda al tocarla, con marca de agua).
//  Puede ordenar, buscar y armar un pedido: se abre WhatsApp al número B2B con el
//  pedido y llega un correo automático a ventas (con copia a la tienda).
//
//  Control interno (Gestión de clientes → vista "Catálogo"):
//   · Todo empieza DESHABILITADO. Se habilitan marcas una por una.
//   · Cada marca tiene un % de descuento estándar.
//   · Dentro de una marca se puede dar otro % a una categoría, subcategoría o etiqueta.
//   · El % se calcula SIEMPRE desde el PVP (precio regular del ERP):
//       precio cliente = PVP × (1 − %/100)
//   · Prioridad: etiqueta > subcategoría > categoría > % estándar de la marca. Si un
//     producto cae en varias etiquetas/categorías con ajuste del mismo nivel, se usa
//     el % más bajo.
//   · Etiquetas: se detectan solas en el ERP (tabla de tags + tabla puente con el
//     producto o la variación). Si el ERP no tiene etiquetas, la opción no aparece.
//   · Los pedidos que hace la tienda son SOLICITUDES: no quedan confirmados hasta que
//     Kuranko los registra en el sistema (puede haber cambios de stock o precio).
//   · Precios y % son una sola lista para todas las tiendas, pero cada tienda ve
//     SOLO las marcas que se le activan a mano en su ficha (todo empieza apagado).
//     Una marca se ve si está habilitada en general Y activada para esa tienda.
//   · % por tienda (opcional), regla por regla: en la ficha de la tienda aparece cada
//     % que existe en el general de esa marca (el estándar y cada ajuste por
//     categoría, subcategoría o etiqueta) y a cada uno se le puede poner el valor de
//     esa tienda. Vacío = usa el general. La prioridad entre reglas no cambia.
//   · Por defecto solo se muestran productos con stock propio (se puede cambiar).
//
//  Marca: se detecta sola en el ERP (products.brand_id → brands.name, o
//  products.brand / marca). Si el ERP no tiene marca, se usa la primera palabra
//  del nombre del producto (igual que Restock).
//
//  Tablas (base del PORTAL): cat_b2b_marcas, cat_b2b_tienda_marcas (marcas por tienda),
//  cat_b2b_ajustes (categorías),
//  cat_b2b_ajustes_tag (etiquetas), cat_b2b_cfg, cat_b2b_pedidos.
//  Permiso admin: clientes_gestion.
// ═══════════════════════════════════════════════════════════════════════════

const TTL = 10 * 60 * 1000;
const esc = t => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const r2 = n => Math.round(n * 100) / 100;
const normMarca = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
const pct = v => { const n = Number(v); return Number.isFinite(n) ? Math.min(95, Math.max(0, r2(n))) : null; };

// ═══ Cálculo puro del % de un producto (se exporta para pruebas) ═══
//  prod: { marca, cats: [{ id, parent_id }], tags: [id] }
//  marcas: Map marca → { habilitada, descuento }
//  ajustes: Map `${marca}|${categoria_id}` → descuento
//  ajustesTag: Map `${marca}|${etiqueta_id}` → descuento (opcional)
//  Devuelve null si la marca no está habilitada.
function descuentoDe(prod, marcas, ajustes, ajustesTag) {
  const m = marcas.get(prod.marca);
  if (!m || !m.habilitada) return null;
  if (ajustesTag && ajustesTag.size) {
    const t = (prod.tags || []).map(id => ajustesTag.get(prod.marca + '|' + id)).filter(v => v != null);
    if (t.length) return { descuento: Math.min(...t), origen: 'etiqueta' };
  }
  const sub = [], cat = [];
  (prod.cats || []).forEach(c => {
    if (c.parent_id) {
      const a = ajustes.get(prod.marca + '|' + c.id);
      if (a != null) sub.push(a);
      const b = ajustes.get(prod.marca + '|' + c.parent_id);
      if (b != null) cat.push(b);
    } else {
      const a = ajustes.get(prod.marca + '|' + c.id);
      if (a != null) cat.push(a);
    }
  });
  if (sub.length) return { descuento: Math.min(...sub), origen: 'subcategoria' };
  if (cat.length) return { descuento: Math.min(...cat), origen: 'categoria' };
  return { descuento: Number(m.descuento) || 0, origen: 'marca' };
}
const precioCliente = (pvp, d) => r2(Number(pvp) * (1 - (Number(d) || 0) / 100));

module.exports = function registrarCatalogoCliente({ app, authAdmin, requiereModulo, prodPool, portalPool,
  authCliente, catalogo, grupos, portal }) {
  const mGest = requiereModulo('clientes_gestion');
  const WA_DEF = (process.env.WA_B2B || '51904286836').replace(/\D/g, '');

  // ─────────── Tablas ───────────
  let listas = false;
  async function prepararTablas() {
    if (listas) return;
    await portalPool.query(`CREATE TABLE IF NOT EXISTS cat_b2b_marcas (
      marca VARCHAR(120) PRIMARY KEY, habilitada TINYINT NOT NULL DEFAULT 0, descuento DECIMAL(5,2) NOT NULL DEFAULT 0,
      actualizado_por VARCHAR(80) NOT NULL DEFAULT '', actualizado_en DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`);
    await portalPool.query(`CREATE TABLE IF NOT EXISTS cat_b2b_ajustes (
      marca VARCHAR(120) NOT NULL, categoria_id BIGINT NOT NULL, descuento DECIMAL(5,2) NOT NULL,
      actualizado_por VARCHAR(80) NOT NULL DEFAULT '', actualizado_en DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (marca, categoria_id))`);
    await portalPool.query(`CREATE TABLE IF NOT EXISTS cat_b2b_ajustes_tag (
      marca VARCHAR(120) NOT NULL, etiqueta_id BIGINT NOT NULL, descuento DECIMAL(5,2) NOT NULL,
      actualizado_por VARCHAR(80) NOT NULL DEFAULT '', actualizado_en DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (marca, etiqueta_id))`);
    await portalPool.query(`CREATE TABLE IF NOT EXISTS cat_b2b_tienda_marcas (
      portal_user_id INT NOT NULL, marca VARCHAR(120) NOT NULL, descuento DECIMAL(5,2) NULL,
      activado_por VARCHAR(80) NOT NULL DEFAULT '', activado_en DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (portal_user_id, marca), KEY ix_marca (marca))`);
    try { await portalPool.query('ALTER TABLE cat_b2b_tienda_marcas ADD COLUMN descuento DECIMAL(5,2) NULL'); } catch (e) { /* ya existe */ }
    // % de una tienda para un ajuste general concreto (tipo 'cat' = categoría/subcategoría, 'tag' = etiqueta)
    await portalPool.query(`CREATE TABLE IF NOT EXISTS cat_b2b_tienda_ajustes (
      portal_user_id INT NOT NULL, marca VARCHAR(120) NOT NULL, tipo VARCHAR(3) NOT NULL, ref_id BIGINT NOT NULL,
      descuento DECIMAL(5,2) NOT NULL, actualizado_por VARCHAR(80) NOT NULL DEFAULT '',
      actualizado_en DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (portal_user_id, marca, tipo, ref_id))`);
    await portalPool.query(`CREATE TABLE IF NOT EXISTS cat_b2b_cfg (clave VARCHAR(40) PRIMARY KEY, valor VARCHAR(255) NOT NULL DEFAULT '')`);
    await portalPool.query(`CREATE TABLE IF NOT EXISTS cat_b2b_pedidos (
      id INT AUTO_INCREMENT PRIMARY KEY, portal_user_id INT NOT NULL, cliente VARCHAR(255) NOT NULL DEFAULT '',
      items JSON NOT NULL, unidades INT NOT NULL DEFAULT 0, total DECIMAL(12,2) NOT NULL DEFAULT 0, nota VARCHAR(1000) NOT NULL DEFAULT '',
      via_admin VARCHAR(80) NULL, correo_enviado TINYINT NOT NULL DEFAULT 0, creado_en DATETIME DEFAULT CURRENT_TIMESTAMP, KEY ix_user (portal_user_id))`);
    listas = true;
  }
  async function leerCfg() {
    await prepararTablas();
    const [rows] = await portalPool.query('SELECT clave, valor FROM cat_b2b_cfg');
    const c = Object.fromEntries(rows.map(r => [r.clave, r.valor]));
    return { wa_b2b: (c.wa_b2b || WA_DEF).replace(/\D/g, ''), solo_stock: c.solo_stock !== '0' };
  }
  async function leerReglas() {
    await prepararTablas();
    const [ms] = await portalPool.query('SELECT marca, habilitada, descuento FROM cat_b2b_marcas');
    const [as] = await portalPool.query('SELECT marca, categoria_id, descuento FROM cat_b2b_ajustes');
    const [ts] = await portalPool.query('SELECT marca, etiqueta_id, descuento FROM cat_b2b_ajustes_tag');
    return {
      marcas: new Map(ms.map(m => [m.marca, { habilitada: !!Number(m.habilitada), descuento: Number(m.descuento) }])),
      ajustes: new Map(as.map(a => [a.marca + '|' + a.categoria_id, Number(a.descuento)])),
      ajustesTag: new Map(ts.map(a => [a.marca + '|' + a.etiqueta_id, Number(a.descuento)]))
    };
  }

  // ─────────── Productos del ERP (marca + categorías + PVP), en caché ───────────
  let _marcaSql;
  async function sqlMarca() {
    if (_marcaSql !== undefined) return _marcaSql;
    _marcaSql = null;
    try {
      const [cols] = await prodPool.query('SHOW COLUMNS FROM products');
      const n = cols.map(c => String(c.Field || c.field || ''));
      const low = n.map(x => x.toLowerCase());
      if (low.includes('brand_id')) {
        for (const t of ['brands', 'product_brands']) {
          try {
            const [tc] = await prodPool.query(`SHOW COLUMNS FROM ${t}`);
            if (tc.some(c => String(c.Field).toLowerCase() === 'name')) { _marcaSql = { expr: 'b.name', join: `LEFT JOIN ${t} b ON b.id = p.brand_id` }; break; }
          } catch (e) { /* no existe */ }
        }
      }
      if (!_marcaSql) {
        const col = ['brand', 'marca', 'brand_name'].find(c => low.includes(c));
        if (col) _marcaSql = { expr: 'p.`' + n[low.indexOf(col)] + '`', join: '' };
      }
    } catch (e) { _marcaSql = null; }
    console.log('[catalogo-b2b] marca:', _marcaSql ? _marcaSql.expr : 'primera palabra del nombre del producto');
    return _marcaSql;
  }
  // Etiquetas del ERP: se busca una tabla de etiquetas (id + name) y una tabla puente
  // con el producto (product_id) o la variación (product_variation_id), o una tabla
  // polimórfica tipo "taggables" (tag_id, taggable_id, taggable_type).
  let _tagSql;
  async function sqlEtiquetas() {
    if (_tagSql !== undefined) return _tagSql;
    _tagSql = null;
    try {
      const [cols] = await prodPool.query(`SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND LOWER(TABLE_NAME) LIKE '%tag%'`);
      const tabs = {};
      cols.forEach(r => { (tabs[r.t] = tabs[r.t] || []).push(String(r.c).toLowerCase()); });
      const tiene = (t, ...cs) => cs.every(c => tabs[t].includes(c));
      const maestra = Object.keys(tabs).find(t => tiene(t, 'id', 'name') && !tabs[t].some(c => /product|taggable/.test(c)));
      if (maestra) {
        const fk = t => ['tag_id', 'product_tag_id', 'etiqueta_id'].find(c => tabs[t].includes(c));
        const puente = Object.keys(tabs).find(t => t !== maestra && fk(t) && (tabs[t].includes('product_id') || tabs[t].includes('product_variation_id')));
        const morph = Object.keys(tabs).find(t => t !== maestra && fk(t) && tiene(t, 'taggable_id', 'taggable_type'));
        if (puente) {
          const porVar = tabs[puente].includes('product_variation_id');
          _tagSql = { sql: `SELECT x.${porVar ? 'product_variation_id' : 'product_id'} AS ref, g.id, g.name FROM \`${puente}\` x JOIN \`${maestra}\` g ON g.id = x.${fk(puente)}`, porVar };
        } else if (morph) {
          _tagSql = { sql: `SELECT x.taggable_id AS ref, x.taggable_type AS tipo, g.id, g.name FROM \`${morph}\` x JOIN \`${maestra}\` g ON g.id = x.${fk(morph)}
            WHERE x.taggable_type LIKE '%Product%'`, morph: true };
        }
      }
    } catch (e) { _tagSql = null; }
    console.log('[catalogo-b2b] etiquetas:', _tagSql ? 'detectadas en el ERP' : 'el ERP no tiene etiquetas reconocibles');
    return _tagSql;
  }
  // name puede venir como JSON de traducciones ({"es":"Outlet"})
  const nombreTag = n => { const s = String(n == null ? '' : n).trim(); if (s.startsWith('{')) { try { const o = JSON.parse(s); return String(o.es || Object.values(o)[0] || s); } catch (e) {} } return s; };

  let _prods = null, _prodsAt = 0, _cargando = null;
  async function productos(forzar) {
    if (!forzar && _prods && Date.now() - _prodsAt < TTL) return _prods;
    if (_cargando) return _cargando;
    _cargando = (async () => {
      const ms = await sqlMarca();
      const [rows] = await prodPool.query(`
        SELECT pv.id AS vid, TRIM(pv.sku) AS sku, pv.name AS variacion, p.id AS pid, p.name AS producto,
          pv.regular_price AS pvp ${ms ? ', ' + ms.expr + ' AS marca' : ''}
        FROM product_variations pv JOIN products p ON p.id = pv.product_id ${ms ? ms.join : ''}
        WHERE pv.deleted_at IS NULL AND p.deleted_at IS NULL
          AND COALESCE(pv.product_type,'') <> 'variable' AND (pv.status IS NULL OR pv.status = 'active')`);
      const catsDe = {}, nombresCat = {};
      try {
        const [cs] = await prodPool.query(`
          SELECT ppc.product_id AS pid, c.id, c.name, c.parent_id, pa.name AS padre
          FROM product_product_category ppc JOIN product_categories c ON c.id = ppc.product_category_id
          LEFT JOIN product_categories pa ON pa.id = c.parent_id`);
        cs.forEach(c => {
          (catsDe[c.pid] = catsDe[c.pid] || []).push({ id: Number(c.id), parent_id: c.parent_id ? Number(c.parent_id) : null });
          nombresCat[c.id] = { nombre: c.name, parent_id: c.parent_id ? Number(c.parent_id) : null };
          if (c.parent_id && !nombresCat[c.parent_id]) nombresCat[c.parent_id] = { nombre: c.padre || `Categoría ${c.parent_id}`, parent_id: null };
        });
      } catch (e) { console.warn('[catalogo-b2b] categorías:', e.message); }
      // Etiquetas por producto o por variación
      const tagsProd = {}, tagsVar = {}, nombresTag = {};
      const ts = await sqlEtiquetas();
      if (ts) {
        try {
          const [tr] = await prodPool.query(ts.sql);
          tr.forEach(t => {
            nombresTag[t.id] = nombreTag(t.name) || `Etiqueta ${t.id}`;
            const esVar = ts.morph ? /Variation/i.test(t.tipo || '') : ts.porVar;
            const m = esVar ? tagsVar : tagsProd;
            (m[t.ref] = m[t.ref] || []).push(Number(t.id));
          });
        } catch (e) { console.warn('[catalogo-b2b] etiquetas:', e.message); }
      }
      // Stock propio e imagen: del catálogo del cotizador (imagen de la variación o, si no tiene, la del producto)
      let stock = {}; const imagen = {};
      try { (await catalogo()).forEach(c => { stock[c.vid] = Number(c.stock) || 0; if (c.imagen) imagen[c.vid] = c.imagen; }); } catch (e) { stock = null; }
      _prods = {
        nombresCat, nombresTag, hayEtiquetas: !!ts, hayStock: !!stock,
        lista: rows.map(r => {
          const nombre = (r.variacion || '').trim() || (r.producto || '').trim();
          const marca = normMarca(r.marca) || normMarca((r.producto || nombre).split(/\s+/)[0]) || 'SIN MARCA';
          return { vid: Number(r.vid), sku: r.sku || '', nombre, marca, pvp: Number(r.pvp) || 0,
            stock: stock ? (stock[r.vid] || 0) : null, cats: catsDe[r.pid] || [], imagen: imagen[r.vid] || null,
            tags: [...new Set([...(tagsProd[r.pid] || []), ...(tagsVar[r.vid] || [])])] };
        }).filter(p => p.nombre)
      };
      _prodsAt = Date.now();
      return _prods;
    })();
    try { return await _cargando; } finally { _cargando = null; }
  }

  // Marcas activadas para una tienda (acceso al portal)
  async function marcasDeTienda(portalUserId) {
    await prepararTablas();
    const [rows] = await portalPool.query('SELECT marca, descuento FROM cat_b2b_tienda_marcas WHERE portal_user_id=?', [portalUserId]);
    return new Map(rows.map(r => [r.marca, r.descuento == null ? null : Number(r.descuento)]));
  }
  async function ajustesDeTienda(portalUserId) {
    await prepararTablas();
    const [rows] = await portalPool.query('SELECT marca, tipo, ref_id, descuento FROM cat_b2b_tienda_ajustes WHERE portal_user_id=?', [portalUserId]);
    return new Map(rows.map(r => [`${r.tipo}|${r.marca}|${r.ref_id}`, Number(r.descuento)]));
  }
  // Reglas efectivas de una tienda: las generales con los % de la tienda encima,
  // solo donde la regla existe en el general (estándar de marca y cada ajuste).
  function reglasDeTienda(reglas, deTienda, ajTienda) {
    const marcas = new Map();
    reglas.marcas.forEach((r, m) => {
      const propio = deTienda.has(m) ? deTienda.get(m) : null;
      marcas.set(m, propio != null ? { ...r, descuento: propio } : r);
    });
    const sobre = (mapa, tipo) => {
      const out = new Map();
      mapa.forEach((v, k) => { const t = ajTienda.get(tipo + '|' + k); out.set(k, t != null ? t : v); });
      return out;
    };
    return { marcas, ajustes: sobre(reglas.ajustes, 'cat'), ajustesTag: sobre(reglas.ajustesTag, 'tag') };
  }

  // Catálogo tal como lo ve la tienda. portalUserId = null → todas las marcas habilitadas
  // (vista general del panel); con un id → solo las marcas activadas para esa tienda.
  async function catalogoCliente(portalUserId) {
    const [{ lista }, reglasGen, cfg, deTienda, ajTienda] = await Promise.all([productos(), leerReglas(), leerCfg(),
      portalUserId != null ? marcasDeTienda(portalUserId) : Promise.resolve(null),
      portalUserId != null ? ajustesDeTienda(portalUserId) : Promise.resolve(null)]);
    const reglas = deTienda ? reglasDeTienda(reglasGen, deTienda, ajTienda) : reglasGen;
    const out = [];
    for (const p of lista) {
      if (deTienda && !deTienda.has(p.marca)) continue;
      if (!(p.pvp > 0)) continue;
      if (cfg.solo_stock && p.stock != null && p.stock <= 0) continue;
      const d = descuentoDe(p, reglas.marcas, reglas.ajustes, reglas.ajustesTag);
      if (!d) continue;
      out.push({ vid: p.vid, marca: p.marca, sku: p.sku, nombre: p.nombre, imagen: p.imagen, pvp: r2(p.pvp), precio: precioCliente(p.pvp, d.descuento), _d: d });
    }
    return { items: out.sort((a, b) => a.marca.localeCompare(b.marca) || a.nombre.localeCompare(b.nombre)), cfg };
  }

  // ═════════════════ ADMIN ═════════════════
  const quien = req => (req.admin && req.admin.usuario) || 'admin';

  // Marcas del ERP con su configuración y su árbol de categorías
  app.get('/api/catalogo-b2b/config', authAdmin, mGest, async (req, res) => {
    try {
      const [{ lista, nombresCat, nombresTag, hayEtiquetas, hayStock }, reglas, cfg] = await Promise.all([productos(req.query.fresh === '1'), leerReglas(), leerCfg()]);
      const porMarca = new Map();
      lista.forEach(p => {
        const m = porMarca.get(p.marca) || { marca: p.marca, productos: 0, con_precio: 0, con_stock: 0, visibles: 0, cats: new Map(), tags: new Map() };
        (p.tags || []).forEach(t => m.tags.set(t, (m.tags.get(t) || 0) + 1));
        m.productos++;
        if (p.pvp > 0) m.con_precio++;
        if (p.stock > 0) m.con_stock++;
        if (p.pvp > 0 && (!cfg.solo_stock || p.stock == null || p.stock > 0)) m.visibles++;
        p.cats.forEach(c => {
          const padre = c.parent_id || c.id;
          const e = m.cats.get(padre) || { id: padre, n: 0, subs: new Map() };
          e.n++;
          if (c.parent_id) e.subs.set(c.id, (e.subs.get(c.id) || 0) + 1);
          m.cats.set(padre, e);
        });
        porMarca.set(p.marca, m);
      });
      // marcas configuradas que ya no aparecen en el ERP también se listan
      reglas.marcas.forEach((v, k) => { if (!porMarca.has(k)) porMarca.set(k, { marca: k, productos: 0, con_precio: 0, con_stock: 0, visibles: 0, cats: new Map(), tags: new Map() }); });
      const nom = id => (nombresCat[id] || {}).nombre || `Categoría ${id}`;
      const marcas = [...porMarca.values()].map(m => {
        const r = reglas.marcas.get(m.marca) || { habilitada: false, descuento: 0 };
        const aj = id => { const v = reglas.ajustes.get(m.marca + '|' + id); return v == null ? null : v; };
        return {
          marca: m.marca, habilitada: r.habilitada, descuento: r.descuento,
          productos: m.productos, con_precio: m.con_precio, con_stock: m.con_stock, visibles: m.visibles,
          ajustes: [...reglas.ajustes.keys(), ...reglas.ajustesTag.keys()].filter(k => k.startsWith(m.marca + '|')).length,
          etiquetas: [...m.tags.entries()].map(([id, n]) => {
            const v = reglas.ajustesTag.get(m.marca + '|' + id);
            return { id, nombre: nombresTag[id] || `Etiqueta ${id}`, n, descuento: v == null ? null : v };
          }).sort((a, b) => b.n - a.n),
          categorias: [...m.cats.values()].map(c => ({
            id: c.id, nombre: nom(c.id), n: c.n, descuento: aj(c.id),
            subs: [...c.subs.entries()].map(([id, n]) => ({ id, nombre: nom(id), n, descuento: aj(id) })).sort((a, b) => a.nombre.localeCompare(b.nombre))
          })).sort((a, b) => b.n - a.n)
        };
      }).sort((a, b) => (b.habilitada - a.habilitada) || b.productos - a.productos);
      const [tm] = await portalPool.query(`SELECT t.marca, COUNT(*) AS n FROM cat_b2b_tienda_marcas t
        JOIN portal_users u ON u.id = t.portal_user_id AND u.activo = 1 GROUP BY t.marca`);
      const tiendasDe = new Map(tm.map(r => [r.marca, Number(r.n)]));
      marcas.forEach(m => { m.tiendas = tiendasDe.get(m.marca) || 0; });
      const [[pend]] = await portalPool.query('SELECT COUNT(*) AS n FROM cat_b2b_pedidos WHERE creado_en >= DATE_SUB(NOW(), INTERVAL 30 DAY)');
      res.json({ cfg, hay_stock: hayStock, hay_etiquetas: hayEtiquetas, marca_detectada: (await sqlMarca()) ? 'erp' : 'primera_palabra',
        marcas, habilitadas: marcas.filter(m => m.habilitada).length, pedidos_30d: Number(pend.n) });
    } catch (e) { console.error('[catalogo-b2b] config', e); res.status(500).json({ error: 'No se pudo leer el catálogo: ' + e.message }); }
  });

  app.put('/api/catalogo-b2b/marca', authAdmin, mGest, async (req, res) => {
    const marca = normMarca((req.body || {}).marca);
    const d = pct((req.body || {}).descuento);
    if (!marca || d == null) return res.status(400).json({ error: 'Marca y % válidos (0 a 95)' });
    try {
      await prepararTablas();
      await portalPool.query(`INSERT INTO cat_b2b_marcas (marca, habilitada, descuento, actualizado_por) VALUES (?,?,?,?)
        ON DUPLICATE KEY UPDATE habilitada=VALUES(habilitada), descuento=VALUES(descuento), actualizado_por=VALUES(actualizado_por)`,
        [marca, req.body.habilitada ? 1 : 0, d, quien(req)]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'Error: ' + e.message }); }
  });

  // Ajuste por categoría/subcategoría dentro de una marca (descuento null = quitar → usa el estándar)
  app.put('/api/catalogo-b2b/ajuste', authAdmin, mGest, async (req, res) => {
    const marca = normMarca((req.body || {}).marca);
    const cat = Number((req.body || {}).categoria_id);
    const vacio = req.body.descuento === null || req.body.descuento === '';
    const d = vacio ? null : pct(req.body.descuento);
    if (!marca || !cat || (!vacio && d == null)) return res.status(400).json({ error: 'Datos no válidos' });
    try {
      await prepararTablas();
      if (vacio) await portalPool.query('DELETE FROM cat_b2b_ajustes WHERE marca=? AND categoria_id=?', [marca, cat]);
      else await portalPool.query(`INSERT INTO cat_b2b_ajustes (marca, categoria_id, descuento, actualizado_por) VALUES (?,?,?,?)
        ON DUPLICATE KEY UPDATE descuento=VALUES(descuento), actualizado_por=VALUES(actualizado_por)`, [marca, cat, d, quien(req)]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'Error: ' + e.message }); }
  });

  // Ajuste por etiqueta dentro de una marca (descuento null = quitar)
  app.put('/api/catalogo-b2b/ajuste-etiqueta', authAdmin, mGest, async (req, res) => {
    const marca = normMarca((req.body || {}).marca);
    const tag = Number((req.body || {}).etiqueta_id);
    const vacio = req.body.descuento === null || req.body.descuento === '';
    const d = vacio ? null : pct(req.body.descuento);
    if (!marca || !tag || (!vacio && d == null)) return res.status(400).json({ error: 'Datos no válidos' });
    try {
      await prepararTablas();
      if (vacio) await portalPool.query('DELETE FROM cat_b2b_ajustes_tag WHERE marca=? AND etiqueta_id=?', [marca, tag]);
      else await portalPool.query(`INSERT INTO cat_b2b_ajustes_tag (marca, etiqueta_id, descuento, actualizado_por) VALUES (?,?,?,?)
        ON DUPLICATE KEY UPDATE descuento=VALUES(descuento), actualizado_por=VALUES(actualizado_por)`, [marca, tag, d, quien(req)]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'Error: ' + e.message }); }
  });

  app.put('/api/catalogo-b2b/cfg', authAdmin, mGest, async (req, res) => {
    const wa = String((req.body || {}).wa_b2b || '').replace(/\D/g, '');
    if (wa && (wa.length < 9 || wa.length > 15)) return res.status(400).json({ error: 'Número de WhatsApp no válido (con código de país, ej. 51987654321)' });
    try {
      await prepararTablas();
      const set = (k, v) => portalPool.query('INSERT INTO cat_b2b_cfg (clave, valor) VALUES (?,?) ON DUPLICATE KEY UPDATE valor=VALUES(valor)', [k, v]);
      if (wa) await set('wa_b2b', wa);
      if (req.body.solo_stock != null) await set('solo_stock', req.body.solo_stock ? '1' : '0');
      res.json({ ok: true, cfg: await leerCfg() });
    } catch (e) { res.status(500).json({ error: 'Error: ' + e.message }); }
  });

  // Vista previa: lo que ve la tienda (con el % y de dónde sale)
  app.get('/api/catalogo-b2b/vista-previa', authAdmin, mGest, async (req, res) => {
    try {
      const tienda = req.query.portal_user_id ? Number(req.query.portal_user_id) : null;
      const { items } = await catalogoCliente(tienda);
      const marca = req.query.marca ? normMarca(req.query.marca) : null;
      res.json({ total: items.length, items: items.filter(i => !marca || i.marca === marca).slice(0, 500)
        .map(({ _d, ...i }) => ({ ...i, descuento: _d.descuento, origen: _d.origen })) });
    } catch (e) { res.status(500).json({ error: 'Error: ' + e.message }); }
  });

  // Marcas de una tienda: todas las del catálogo (habilitadas o no) con su estado para esa tienda
  app.get('/api/catalogo-b2b/tienda/:id', authAdmin, mGest, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const [reglas, act, aj, { lista, nombresCat, nombresTag }] = await Promise.all([leerReglas(), marcasDeTienda(id), ajustesDeTienda(id), productos()]);
      const cuenta = {};
      lista.forEach(p => { if (p.pvp > 0) cuenta[p.marca] = (cuenta[p.marca] || 0) + 1; });
      // Cada ajuste general de la marca, con su valor para esta tienda (si tiene)
      const reglasDe = marca => {
        const out = [];
        const ord = { tag: 0, sub: 1, cat: 2 };
        reglas.ajustesTag.forEach((v, k) => { const [m, ref] = k.split('|'); if (m === marca) out.push({ tipo: 'tag', nivel: 'etiqueta', ref_id: Number(ref),
          nombre: nombresTag[ref] || `Etiqueta ${ref}`, general: v, tienda: aj.has('tag|' + k) ? aj.get('tag|' + k) : null }); });
        reglas.ajustes.forEach((v, k) => { const [m, ref] = k.split('|'); if (m !== marca) return;
          const c = nombresCat[ref] || {}; const padre = c.parent_id ? (nombresCat[c.parent_id] || {}).nombre : null;
          out.push({ tipo: 'cat', nivel: c.parent_id ? 'subcategoría' : 'categoría', ref_id: Number(ref),
            nombre: (padre ? padre + ' › ' : '') + (c.nombre || `Categoría ${ref}`), general: v, tienda: aj.has('cat|' + k) ? aj.get('cat|' + k) : null }); });
        return out.sort((a, b) => ord[a.tipo === 'cat' && a.nivel === 'subcategoría' ? 'sub' : a.tipo] - ord[b.tipo === 'cat' && b.nivel === 'subcategoría' ? 'sub' : b.tipo] || a.nombre.localeCompare(b.nombre));
      };
      const marcas = [...reglas.marcas.entries()].filter(([m, r]) => r.habilitada || act.has(m))
        .map(([marca, r]) => ({ marca, habilitada: r.habilitada, descuento: r.descuento, activa: act.has(marca),
          descuento_tienda: act.has(marca) ? act.get(marca) : null, productos: cuenta[marca] || 0, reglas: reglasDe(marca) }))
        .sort((a, b) => (b.activa - a.activa) || a.marca.localeCompare(b.marca));
      res.json({ marcas, activas: marcas.filter(m => m.activa && m.habilitada).length });
    } catch (e) { res.status(500).json({ error: 'Error: ' + e.message }); }
  });
  // Activar/desactivar una marca para una tienda (portal_user_id) — o varias tiendas a la vez
  app.put('/api/catalogo-b2b/tienda', authAdmin, mGest, async (req, res) => {
    const marca = normMarca((req.body || {}).marca);
    const ids = (Array.isArray(req.body.portal_user_ids) ? req.body.portal_user_ids : [req.body.portal_user_id]).map(Number).filter(Boolean);
    if (!marca || !ids.length) return res.status(400).json({ error: 'Faltan datos' });
    try {
      await prepararTablas();
      if (req.body.activa) await portalPool.query('INSERT IGNORE INTO cat_b2b_tienda_marcas (portal_user_id, marca, activado_por) VALUES ?', [ids.map(i => [i, marca, quien(req)])]);
      else await portalPool.query('DELETE FROM cat_b2b_tienda_marcas WHERE marca=? AND portal_user_id IN (?)', [marca, ids]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'Error: ' + e.message }); }
  });
  // % manual de una marca para una tienda (null o '' = quitar → usa los % generales)
  app.put('/api/catalogo-b2b/tienda-descuento', authAdmin, mGest, async (req, res) => {
    const marca = normMarca((req.body || {}).marca);
    const id = Number((req.body || {}).portal_user_id);
    const vacio = req.body.descuento === null || req.body.descuento === '';
    const d = vacio ? null : pct(req.body.descuento);
    if (!marca || !id || (!vacio && d == null)) return res.status(400).json({ error: 'Datos no válidos (% de 0 a 95)' });
    try {
      await prepararTablas();
      const [r] = await portalPool.query('UPDATE cat_b2b_tienda_marcas SET descuento=? WHERE portal_user_id=? AND marca=?', [d, id, marca]);
      if (!r.affectedRows) return res.status(409).json({ error: 'Primero activa la marca para esta tienda' });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'Error: ' + e.message }); }
  });

  // % de una tienda para un ajuste general (tipo 'cat' o 'tag'); null/'' = quitar → usa el general
  app.put('/api/catalogo-b2b/tienda-ajuste', authAdmin, mGest, async (req, res) => {
    const b = req.body || {};
    const marca = normMarca(b.marca), id = Number(b.portal_user_id), ref = Number(b.ref_id), tipo = b.tipo === 'tag' ? 'tag' : b.tipo === 'cat' ? 'cat' : null;
    const vacio = b.descuento === null || b.descuento === '';
    const d = vacio ? null : pct(b.descuento);
    if (!marca || !id || !ref || !tipo || (!vacio && d == null)) return res.status(400).json({ error: 'Datos no válidos (% de 0 a 95)' });
    try {
      await prepararTablas();
      const [[act]] = await portalPool.query('SELECT 1 AS ok FROM cat_b2b_tienda_marcas WHERE portal_user_id=? AND marca=?', [id, marca]);
      if (!act) return res.status(409).json({ error: 'Primero activa la marca para esta tienda' });
      if (vacio) await portalPool.query('DELETE FROM cat_b2b_tienda_ajustes WHERE portal_user_id=? AND marca=? AND tipo=? AND ref_id=?', [id, marca, tipo, ref]);
      else await portalPool.query(`INSERT INTO cat_b2b_tienda_ajustes (portal_user_id, marca, tipo, ref_id, descuento, actualizado_por) VALUES (?,?,?,?,?,?)
        ON DUPLICATE KEY UPDATE descuento=VALUES(descuento), actualizado_por=VALUES(actualizado_por)`, [id, marca, tipo, ref, d, quien(req)]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'Error: ' + e.message }); }
  });

  // Tiendas (accesos activos) y si tienen activada una marca
  app.get('/api/catalogo-b2b/marca-tiendas', authAdmin, mGest, async (req, res) => {
    const marca = normMarca(req.query.marca);
    try {
      await prepararTablas();
      const [rows] = await portalPool.query(`SELECT u.id, u.nombre_cliente, u.username, t.marca IS NOT NULL AS activa, t.descuento AS descuento_tienda
        FROM portal_users u LEFT JOIN cat_b2b_tienda_marcas t ON t.portal_user_id=u.id AND t.marca=?
        WHERE u.activo=1 ORDER BY u.nombre_cliente`, [marca]);
      res.json(rows.map(r => ({ ...r, activa: !!Number(r.activa), descuento_tienda: r.descuento_tienda == null ? null : Number(r.descuento_tienda) })));
    } catch (e) { res.status(500).json({ error: 'Error: ' + e.message }); }
  });

  app.get('/api/catalogo-b2b/pedidos', authAdmin, mGest, async (req, res) => {
    try {
      await prepararTablas();
      const [rows] = await portalPool.query('SELECT * FROM cat_b2b_pedidos ORDER BY id DESC LIMIT 100');
      res.json(rows.map(r => ({ ...r, items: typeof r.items === 'string' ? JSON.parse(r.items) : r.items, total: Number(r.total) })));
    } catch (e) { res.status(500).json({ error: 'Error: ' + e.message }); }
  });

  // ═════════════════ PORTAL DEL CLIENTE ═════════════════
  app.get('/portal/catalogo', authCliente, async (req, res) => {
    try {
      const { items, cfg } = await catalogoCliente(req.cliente.portal_user_id);
      // Solo los campos pedidos: marca, SKU, nombre, imagen, PVP y precio del cliente
      res.json({ wa_b2b: cfg.wa_b2b, items: items.map(({ _d, ...i }) => i) });
    } catch (e) { res.status(500).json({ error: 'No se pudo cargar el catálogo' }); }
  });

  // Pedido desde el catálogo: precios recalculados en el servidor, correo a ventas
  // (copia a la tienda) y texto listo para WhatsApp al número B2B.
  app.post('/portal/catalogo/pedido', authCliente, async (req, res) => {
    const pedido = Array.isArray((req.body || {}).items) ? req.body.items : [];
    const nota = String((req.body || {}).nota || '').slice(0, 1000);
    try {
      const { items, cfg } = await catalogoCliente(req.cliente.portal_user_id);
      const porVid = new Map(items.map(i => [i.vid, i]));
      const lineas = [];
      for (const x of pedido) {
        const it = porVid.get(Number(x.vid));
        const cant = Math.round(Number(x.cantidad));
        if (!it || !(cant > 0) || cant > 9999) continue;
        if (lineas.some(l => l.vid === it.vid)) continue;
        lineas.push({ vid: it.vid, marca: it.marca, sku: it.sku, nombre: it.nombre, pvp: it.pvp, precio: it.precio, cantidad: cant, subtotal: r2(it.precio * cant) });
      }
      if (!lineas.length) return res.status(400).json({ error: 'El pedido no tiene productos válidos del catálogo' });
      const unidades = lineas.reduce((a, l) => a + l.cantidad, 0);
      const total = r2(lineas.reduce((a, l) => a + l.subtotal, 0));
      await prepararTablas();
      const [r] = await portalPool.query(
        `INSERT INTO cat_b2b_pedidos (portal_user_id, cliente, items, unidades, total, nota, via_admin) VALUES (?,?,?,?,?,?,?)`,
        [req.cliente.portal_user_id, req.cliente.nombre || '', JSON.stringify(lineas), unidades, total, nota, req.cliente.via_admin || null]);
      const id = r.insertId;
      const S = n => 'S/ ' + Number(n).toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

      // Correo: Para ventas, CC info + la tienda
      let emailCli = null;
      try { emailCli = portal && portal.correoEmpresa ? await portal.correoEmpresa(req.cliente.ids || [req.cliente.customer_id]) : null; } catch (e) { emailCli = null; }
      const vistos = new Set();
      const unico = x => { const k = x.toLowerCase(); if (vistos.has(k)) return false; vistos.add(k); return true; };
      const internos = [...(process.env.VENTAS_EMAIL || 'ventas@kuranko.pe').split(','), 'info@kuranko.pe'].map(x => x.trim()).filter(x => /@/.test(x)).filter(unico);
      const to = internos.slice(0, 1), cc = [...internos.slice(1), ...(emailCli && unico(emailCli) ? [emailCli] : [])];
      const filas = lineas.map((l, n) => `<tr>
        <td style="padding:6px 10px;border:1px solid #e0e0e0;text-align:center">${n + 1}</td>
        <td style="padding:6px 10px;border:1px solid #e0e0e0">${esc(l.marca)}</td>
        <td style="padding:6px 10px;border:1px solid #e0e0e0;font-family:monospace">${esc(l.sku) || '—'}</td>
        <td style="padding:6px 10px;border:1px solid #e0e0e0">${esc(l.nombre)}</td>
        <td style="padding:6px 10px;border:1px solid #e0e0e0;text-align:center">${l.cantidad}</td>
        <td style="padding:6px 10px;border:1px solid #e0e0e0;text-align:right">${S(l.precio)}</td>
        <td style="padding:6px 10px;border:1px solid #e0e0e0;text-align:right">${S(l.subtotal)}</td></tr>`).join('');
      const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;max-width:720px">
        <h2 style="color:#000726;margin-bottom:4px">Solicitud de pedido B2B N° ${id} — ${esc(req.cliente.nombre)}</h2>
        <p style="background:#eef2ff;padding:10px 14px;border-radius:6px"><b>Esta solicitud aún no es un pedido confirmado.</b> Se confirma cuando Kuranko la registra en el sistema; puede tener cambios (stock, cantidades o precio).</p>
        <p style="color:#555">Usuario del portal: ${esc(req.cliente.ruc || '')} · ${new Date().toLocaleString('es-PE', { timeZone: 'America/Lima' })}${req.cliente.via_admin ? ' · enviado por Kuranko con "ver como cliente"' : ''}</p>
        ${nota ? `<p style="background:#fef3c7;padding:10px 14px;border-radius:6px">Nota: ${esc(nota)}</p>` : ''}
        <table style="border-collapse:collapse;width:100%;font-size:13px"><thead><tr style="background:#000726;color:#fff">
          <th style="padding:6px 10px">N°</th><th style="padding:6px 10px;text-align:left">Marca</th><th style="padding:6px 10px;text-align:left">SKU</th>
          <th style="padding:6px 10px;text-align:left">Producto</th><th style="padding:6px 10px">Cant.</th><th style="padding:6px 10px;text-align:right">Precio</th><th style="padding:6px 10px;text-align:right">Subtotal</th></tr></thead>
          <tbody>${filas}</tbody>
          <tfoot><tr><td colspan="4" style="padding:6px 10px;text-align:right"><b>Total</b></td><td style="padding:6px 10px;text-align:center"><b>${unidades}</b></td><td></td><td style="padding:6px 10px;text-align:right"><b>${S(total)}</b></td></tr></tfoot></table>
        <p style="color:#666;font-size:13px;margin-top:14px">Solicitud enviada desde el catálogo del Portal Kuranko. Precios referenciales del catálogo a la fecha; Kuranko confirma disponibilidad y precio final al registrar el pedido.</p></div>`;
      const texto = `Solicitud de pedido B2B N° ${id} — ${req.cliente.nombre}\n(No es un pedido confirmado: se confirma al registrarlo en el sistema y puede tener cambios.)\n` + (nota ? `Nota: ${nota}\n` : '') + '\n' +
        lineas.map((l, n) => `${n + 1}. ${l.cantidad} x [${l.sku || '—'}] ${l.nombre} — ${S(l.precio)} = ${S(l.subtotal)}`).join('\n') +
        `\n\nTotal: ${unidades} unidades · ${S(total)}`;
      let correo = false;
      if (process.env.RESEND_API_KEY) {
        try {
          const rr = await fetch('https://api.resend.com/emails', {
            method: 'POST', headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: process.env.RESEND_FROM || 'Portal Kuranko <noreply@kuranko.pe>', to, cc, reply_to: emailCli || 'ventas@kuranko.pe',
              subject: `Solicitud de pedido B2B N° ${id} — ${req.cliente.nombre}`, html, text: texto })
          });
          if (!rr.ok) console.error('[catalogo-b2b] Resend falló:', rr.status, await rr.text());
          correo = rr.ok;
        } catch (e) { correo = false; }
      }
      if (correo) portalPool.query('UPDATE cat_b2b_pedidos SET correo_enviado=1 WHERE id=?', [id]).catch(() => {});
      // Mensaje de WhatsApp (lo abre el navegador de la tienda)
      const wa = `📦 *Solicitud de pedido B2B N° ${id}* — ${req.cliente.nombre}\nUsuario: ${req.cliente.ruc || ''}\n\n` +
        lineas.map(l => `▪ ${l.cantidad} x ${l.nombre} (SKU ${l.sku || 's/c'}) — ${S(l.precio)}`).join('\n') +
        `\n\n*Total referencial:* ${unidades} und · ${S(total)}` + (nota ? `\n*Nota:* ${nota}` : '') +
        `\n\n_Solicitud sin confirmar: Kuranko la confirma al registrarla en el sistema._`;
      res.json({ ok: true, id, unidades, total, correo_enviado: correo, copia_cliente: !!emailCli,
        whatsapp: `https://wa.me/${cfg.wa_b2b}?text=${encodeURIComponent(wa)}` });
    } catch (e) { console.error('[catalogo-b2b] pedido', e); res.status(500).json({ error: 'No se pudo enviar el pedido' }); }
  });

  return { prepararTablas };
};

module.exports._test = { descuentoDe, precioCliente, normMarca };
