// ═══════════════════════════════════════════════════════════════════════════
//  MÓDULO: Auditoría de catálogo → pestaña "Editar catálogo"
//  Lista el catálogo del ERP por FAMILIA (padre variable + variaciones, o simple) para
//  editarlo en bloque (la escritura la hace auditoria-bloque.js).
//
//  GET /admin/auditoria/catalogo   (permiso 'auditoria', solo lectura)
//    solo_alertas=1 (def.) → solo familias con alguna alerta en el último análisis
//    sev, tipo           → filtran por alertas (severidad / tipo de alerta)
//    marca, estado (active|draft|discontinued, alguna variación), web (si|no), q, pagina
// ═══════════════════════════════════════════════════════════════════════════

const EXCLUIR_STOCK = (process.env.PROMO_EXCLUIR || process.env.STOCK_EXCLUIR || 'CUARENTENA,EMBAJADOR')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const POR_PAGINA = 200;
const txt = x => x == null ? '' : String(x);
const num = x => (x === null || x === undefined || x === '') ? null : Number(x);
const marcaDe = producto => (txt(producto).trim().split(/\s+/)[0] || '—');

// Agrupa filas del ERP en familias (puro, exportado para pruebas)
function armarFamilias(vars, prods, stock, back, alertasPorVid) {
  const prodPorId = {}; prods.forEach(p => prodPorId[p.id] = p);
  const fam = {};
  vars.forEach(v => {
    const f = fam[v.product_id] = fam[v.product_id] || { pid: v.product_id, filas: [] };
    f.filas.push(v);
  });
  return Object.values(fam).map(f => {
    const p = prodPorId[f.pid] || {};
    const padre = f.filas.find(v => v.product_type === 'variable');
    const hijas = f.filas.filter(v => v.product_type !== 'variable');
    const todas = f.filas;
    const uniq = arr => [...new Set(arr.map(x => x == null || x === '' ? '—' : String(x)))];
    const medida = k => { const u = uniq(todas.map(v => num(v[k]) == null ? null : Number(v[k]))); return u.length === 1 ? u[0] : 'varios'; };
    const precios = todas.map(v => num(v.regular_price)).filter(x => x > 0);
    const alertas = [];
    todas.forEach(v => (alertasPorVid[v.id] || []).forEach(a => alertas.push(a)));
    const tipos = {}; alertas.forEach(a => tipos[a.tipo] = (tipos[a.tipo] || 0) + 1);
    return {
      pid: f.pid, vid: (hijas[0] || padre || todas[0]).id,
      nombre: p.name || (padre && padre.name) || (hijas[0] && hijas[0].name) || '',
      sku: txt((padre || hijas[0] || {}).sku).trim(), tipo: padre || hijas.length > 1 ? 'variable' : 'simple',
      marca: marcaDe(p.name), variaciones: hijas.length,
      en_web: todas.some(v => v.woocommerce_id),
      estados: uniq(todas.map(v => v.status)), reservas: uniq(todas.map(v => back[v.id] === undefined ? 'sin fila' : (back[v.id] || 'vacío'))),
      precio: precios.length ? Math.max(...precios) : null, precio_varios: new Set(precios).size > 1,
      peso: medida('weight'), largo: medida('length'), ancho: medida('width'), alto: medida('height'),
      stock: hijas.reduce((s, v) => s + (stock[v.id] || 0), 0),
      alertas: Object.keys(tipos).map(t => ({ tipo: t, n: tipos[t], sev: (alertas.find(a => a.tipo === t) || {}).sev })),
      sevs: [...new Set(alertas.map(a => a.sev))]
    };
  });
}

module.exports = function registrarCatalogo({ app, authAdmin, requiereModulo, prodPool, portalPool }) {
  const mAud = requiereModulo('auditoria');

  app.get('/admin/auditoria/catalogo', authAdmin, mAud, async (req, res) => {
    try {
      const q = req.query || {};
      const soloAlertas = q.solo_alertas !== '0';
      // Alertas del último análisis guardado
      let alertas = [], generado = null;
      try {
        const [[row]] = await portalPool.query('SELECT generado_en, resultado FROM auditoria_cache WHERE id = 1');
        if (row && row.resultado) { const d = JSON.parse(row.resultado); alertas = d.alertas || []; generado = row.generado_en; }
      } catch (e) { /* sin análisis */ }
      const porVid = {};
      alertas.filter(a => (!q.sev || a.sev === q.sev) && (!q.tipo || a.tipo === q.tipo))
        .forEach(a => (porVid[a.vid] = porVid[a.vid] || []).push({ tipo: a.tipo, sev: a.sev }));

      let pids;
      if (soloAlertas) {
        const vids = Object.keys(porVid).map(Number);
        if (!vids.length) return res.json({ familias: [], total: 0, pagina: 1, paginas: 0, generado_en: generado, marcas: [] });
        const [r] = await prodPool.query(`SELECT DISTINCT product_id FROM product_variations WHERE id IN (?)`, [vids]);
        pids = r.map(x => x.product_id);
      }
      const [vars] = await prodPool.query(
        `SELECT pv.id, pv.product_id, TRIM(pv.sku) AS sku, pv.name, pv.product_type, pv.status, pv.regular_price,
                pv.weight, pv.length, pv.width, pv.height, pv.woocommerce_id
           FROM product_variations pv
          WHERE pv.deleted_at IS NULL ${pids ? 'AND pv.product_id IN (?)' : ''}`, pids ? [pids] : []);
      if (!vars.length) return res.json({ familias: [], total: 0, pagina: 1, paginas: 0, generado_en: generado, marcas: [] });
      const prodIds = [...new Set(vars.map(v => v.product_id))];
      const todas = vars.map(v => v.id);
      const [[prods], [st], [bk]] = await Promise.all([
        prodPool.query(`SELECT id, name FROM products WHERE id IN (?)`, [prodIds]),
        prodPool.query(`SELECT ls.product_variation_id AS vid, SUM(ls.quantity) AS qty FROM location_stocks ls
                          JOIN locations l ON l.id = ls.location_id
                         WHERE ls.product_variation_id IN (?) AND UPPER(TRIM(l.name)) NOT IN (?) GROUP BY ls.product_variation_id`,
          [todas, EXCLUIR_STOCK.length ? EXCLUIR_STOCK : ['']]),
        prodPool.query(`SELECT product_variation_id AS vid, backorder_mode FROM product_variation_stocks WHERE product_variation_id IN (?) ORDER BY id`, [todas])
      ]);
      const stock = {}; st.forEach(r => stock[r.vid] = Number(r.qty) || 0);
      const back = {}; bk.forEach(r => { if (!(r.vid in back)) back[r.vid] = r.backorder_mode; });

      let familias = armarFamilias(vars, prods, stock, back, porVid);
      if (soloAlertas) familias = familias.filter(f => f.alertas.length);
      const marcas = [...new Set(familias.map(f => f.marca).filter(m => m !== '—'))].sort((a, b) => a.localeCompare(b));
      const t = txt(q.q).toLowerCase().trim();
      familias = familias.filter(f =>
        (!q.marca || f.marca === q.marca) && (!q.estado || f.estados.includes(q.estado)) &&
        (!q.web || (q.web === 'si' ? f.en_web : !f.en_web)) &&
        (!t || f.nombre.toLowerCase().includes(t) || f.sku.toLowerCase().includes(t) ||
          vars.some(v => v.product_id === f.pid && txt(v.sku).toLowerCase().includes(t))));
      familias.sort((a, b) => b.alertas.length - a.alertas.length || a.nombre.localeCompare(b.nombre));
      // Para "seleccionar todos los filtrados" (todas las páginas): solo los ids
      if (q.solo_ids === '1') return res.json({ vids: familias.map(f => f.vid), total: familias.length });
      const total = familias.length, paginas = Math.ceil(total / POR_PAGINA);
      const pagina = Math.min(Math.max(1, Number(q.pagina) || 1), Math.max(1, paginas));
      res.json({ familias: familias.slice((pagina - 1) * POR_PAGINA, pagina * POR_PAGINA), total, pagina, paginas,
        por_pagina: POR_PAGINA, generado_en: generado, marcas });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
};

module.exports._test = { armarFamilias };
