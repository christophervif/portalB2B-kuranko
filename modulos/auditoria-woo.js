// ═══════════════════════════════════════════════════════════════════════════
//  MÓDULO: Auditoría → Pendientes en la web → "Excel para WooCommerce"
//  Llena la plantilla del usuario plantillas/creacion-productos-woocommerce.xlsx:
//   · escribe los datos en la pestaña "Sistema" desde la fila 2 (la fila 1 no se toca);
//   · NO toca "Para woocommerce", "Info" ni "Valores" (sus fórmulas leen "Sistema"),
//     salvo que haya más filas que fórmulas: entonces copia la última fila de fórmulas
//     hacia abajo (mismas fórmulas, solo cambia el número de fila);
//   · pide a Excel recalcular al abrir (los valores guardados eran de otros datos).
//  Las filas siguen el MISMO formato que el exportador del ERP
//  (app/Filament/Resources/Inventory/Exporters/WooCommerceExporter.php):
//   simple → 1 fila · variable → fila padre (si el padre aún no está en la web) + sus
//   variaciones pendientes elegidas (Superior = sku_base del padre).
//  Se edita el XML del archivo directamente (jszip) para no alterar formatos ni fórmulas.
//
//  POST /admin/auditoria/pendientes-woo-excel  { vids:[…] }   (permiso 'auditoria')
// ═══════════════════════════════════════════════════════════════════════════

const path = require('path');
const fs = require('fs');
const JSZip = require('jszip');

const PLANTILLA = path.join(__dirname, '..', 'plantillas', 'creacion-productos-woocommerce.xlsx');
const HOJA_DATOS = 'Sistema';
const HOJA_FORMULAS = 'Para woocommerce';
const MAX_ATRIBUTOS = 10;

const txt = x => x == null ? '' : String(x);
// Igual que formatDecimal() del ERP: entero sin decimales; si no, hasta 3 sin ceros sobrantes
function decimal(v) {
  if (v === null || v === undefined || v === '') return '';
  const f = Number(v); if (!isFinite(f)) return '';
  return Number.isInteger(f) ? f : Number(f.toFixed(3));
}
const publicado = st => st === 'active' ? 1 : st === 'draft' ? -1 : 0;           // publishedFlag()
const reservas = m => { m = m == null ? 'yes' : m; return m === 'no' ? 0 : m === 'notify' ? 'notify' : 1; }; // backorderFlag()
const nl = s => typeof s === 'string' ? s.replace(/\r\n|\r|\n/g, '\\n') : s;      // escapeNewlines()

// ── Filas (formato del exportador del ERP) — puro, exportado para pruebas ──
//  d = { prods:{pid:{id,name,description,is_featured,woocommerce_id,sku_base,product_type}},
//        vars:[{id,product_id,sku,name,product_type,status,is_default,regular_price,sale_price,weight,length,width,height,woocommerce_id}],
//        stock:{vid:n}, pvs:{vid:{backorder_mode,low_stock_threshold}}, cats:{pid:'A > B, C'}, tags:{pid:'x, y'},
//        imgProd:{pid:[url]}, imgVar:{vid:[url]}, attrVis:{pid:{nombre:bool}}, attrVar:{vid:[{nombre,valor}]} }
function armarFilas(d, vidsElegidos) {
  const elegidos = new Set(vidsElegidos.map(Number));
  const porProd = {};
  d.vars.forEach(v => (porProd[v.product_id] = porProd[v.product_id] || []).push(v));
  const orden = (a, b) => (a.woocommerce_id == null) - (b.woocommerce_id == null) || (a.woocommerce_id || 0) - (b.woocommerce_id || 0) || a.id - b.id;
  const pidsOrden = [...new Set(d.vars.filter(v => elegidos.has(v.id)).sort(orden).map(v => v.product_id))];
  const filas = [];
  const stockDe = v => Number(d.stock[v.id]) || 0;
  const imgs = arr => [...new Set((arr || []).filter(Boolean))].join(', ');
  const atributos = (lista) => {
    const out = []; let n = 0;
    for (const a of lista) { if (n >= MAX_ATRIBUTOS) break; out.push(a.nombre, a.valores.join(', '), a.visible ? 1 : 0, 1); n++; }
    while (n++ < MAX_ATRIBUTOS) out.push('', '', '', '');
    return out;
  };
  const attrDeVar = (v, pid) => (d.attrVar[v.id] || []).map(a => ({ nombre: a.nombre, valores: [a.valor], visible: (d.attrVis[pid] || {})[a.nombre] !== false }));
  const base = x => [
    x.id ?? '', x.tipo, x.sku, '', x.nombre, x.publicado, x.destacado, x.visibilidad, '', x.descripcion, '', '',
    'taxable', '', x.existencias || 1, x.inventario, x.bajo ?? '', x.reservas ?? 1, 0,
    x.peso, x.longitud, x.anchura, x.altura, 1, '', x.rebajado, x.normal, x.categorias, x.etiquetas, '',
    x.imagenes, '', '', x.superior, '', '', '', '', '', 0, '', ''];

  for (const pid of pidsOrden) {
    const p = d.prods[pid] || {};
    const vs = (porProd[pid] || []).slice().sort(orden);
    const esVariable = p.product_type === 'variable' || vs.some(v => v.product_type === 'variable');
    if (!esVariable) {
      const v = vs.find(x => Number(x.is_default) === 1) || vs[0];
      if (!v) continue;
      const st = stockDe(v), pv = d.pvs[v.id] || {};
      filas.push(base({
        id: p.woocommerce_id ?? '', tipo: 'simple', sku: v.sku || p.sku_base, nombre: p.name,
        publicado: publicado(v.status), destacado: p.is_featured ? 1 : 0, visibilidad: v.status === 'active' ? 'visible' : 'hidden',
        descripcion: p.description || '', existencias: st > 0 ? 1 : 0, inventario: st, bajo: pv.low_stock_threshold ?? '',
        reservas: reservas(pv.backorder_mode), peso: decimal(v.weight), longitud: decimal(v.length), anchura: decimal(v.width),
        altura: decimal(v.height), rebajado: decimal(v.sale_price), normal: decimal(v.regular_price),
        categorias: d.cats[pid] || '', etiquetas: d.tags[pid] || '',
        imagenes: imgs((d.imgProd[pid] || []).length ? d.imgProd[pid] : d.imgVar[v.id]), superior: ''
      }).concat(atributos(attrDeVar(v, pid))));
      continue;
    }
    const def = vs.find(v => Number(v.is_default) === 1);
    const hijas = vs.filter(v => Number(v.is_default) !== 1);
    // Fila padre: solo si el padre aún no está en la web (para no pisar uno existente al importar)
    const padreEnWeb = !!(p.woocommerce_id || (def && def.woocommerce_id));
    if (!padreEnWeb) {
      const activa = vs.some(v => v.status === 'active');
      const est = activa ? 'active' : (vs.some(v => v.status === 'draft') ? 'draft' : 'discontinued');
      const total = hijas.reduce((s, v) => s + stockDe(v), 0);
      const pv = def ? (d.pvs[def.id] || {}) : {};
      // Atributos del padre: unión de valores de todas las variaciones
      const union = {};
      vs.forEach(v => (d.attrVar[v.id] || []).forEach(a => {
        const u = union[a.nombre] = union[a.nombre] || { nombre: a.nombre, valores: [], visible: (d.attrVis[pid] || {})[a.nombre] !== false };
        if (!u.valores.includes(a.valor)) u.valores.push(a.valor);
      }));
      filas.push(base({
        id: p.woocommerce_id ?? '', tipo: 'variable', sku: p.sku_base || (def && def.sku), nombre: p.name,
        publicado: publicado(est), destacado: p.is_featured ? 1 : 0, visibilidad: activa ? 'visible' : 'hidden',
        descripcion: p.description || '', existencias: total > 0 ? 1 : 0, inventario: total,
        bajo: def ? (pv.low_stock_threshold ?? '') : '', reservas: def ? reservas(pv.backorder_mode) : 1,
        peso: decimal(def && def.weight), longitud: decimal(def && def.length), anchura: decimal(def && def.width),
        altura: decimal(def && def.height), rebajado: '', normal: '',
        categorias: d.cats[pid] || '', etiquetas: d.tags[pid] || '',
        imagenes: imgs((d.imgProd[pid] || []).length ? d.imgProd[pid] : (def ? d.imgVar[def.id] : [])), superior: ''
      }).concat(atributos(Object.values(union))));
    }
    for (const v of hijas) {
      if (!elegidos.has(v.id)) continue;
      const st = stockDe(v), pv = d.pvs[v.id] || {};
      filas.push(base({
        id: v.woocommerce_id ?? '', tipo: 'variation', sku: v.sku, nombre: v.name || p.name,
        publicado: publicado(v.status), destacado: 0, visibilidad: v.status === 'active' ? 'visible' : 'hidden',
        descripcion: '', existencias: st > 0 ? 1 : 0, inventario: st, bajo: pv.low_stock_threshold ?? '',
        reservas: reservas(pv.backorder_mode), peso: decimal(v.weight), longitud: decimal(v.length), anchura: decimal(v.width),
        altura: decimal(v.height), rebajado: decimal(v.sale_price), normal: decimal(v.regular_price),
        categorias: '', etiquetas: '', imagenes: imgs(d.imgVar[v.id]), superior: p.sku_base || (def && def.sku) || ''
      }).concat(atributos(attrDeVar(v, pid))));
    }
  }
  return filas.map(f => f.map(nl));
}

// ── XML helpers ──
const escXml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
function colLetra(n) { let s = ''; n++; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
function celda(ref, v) {
  if (v === '' || v === null || v === undefined) return '';
  if (typeof v === 'number' && isFinite(v)) return `<c r="${ref}"><v>${v}</v></c>`;
  const t = String(v).slice(0, 32767);
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escXml(t)}</t></is></c>`;
}

// Rutas de las hojas por nombre (workbook.xml + rels)
async function rutasHojas(zip) {
  const wb = await zip.file('xl/workbook.xml').async('string');
  const rels = await zip.file('xl/_rels/workbook.xml.rels').async('string');
  const out = {};
  for (const m of wb.matchAll(/<sheet [^>]*name="([^"]+)"[^>]*r:id="([^"]+)"[^>]*\/>/g)) {
    const r = rels.match(new RegExp(`<Relationship [^>]*Id="${m[2]}"[^>]*Target="([^"]+)"`)) ||
              rels.match(new RegExp(`<Relationship [^>]*Target="([^"]+)"[^>]*Id="${m[2]}"`));
    if (r) out[m[1].replace(/&amp;/g, '&')] = 'xl/' + r[1].replace(/^\/?xl\//, '');
  }
  return out;
}

async function llenarPlantilla(buffer, filas) {
  const zip = await JSZip.loadAsync(buffer);
  const hojas = await rutasHojas(zip);
  if (!hojas[HOJA_DATOS]) throw new Error(`La plantilla no tiene la pestaña "${HOJA_DATOS}".`);

  // 1) "Sistema": se conserva la fila 1 y se reemplaza el resto
  let xml = await zip.file(hojas[HOJA_DATOS]).async('string');
  const ini = xml.indexOf('<sheetData'), fin = xml.indexOf('</sheetData>');
  const sheetData = xml.slice(ini, fin);
  const fila1 = (sheetData.match(/<row [^>]*r="1"[\s\S]*?<\/row>/) || [''])[0];
  const apertura = sheetData.match(/<sheetData[^>]*>/)[0];
  const nCols = Math.max(82, ...filas.map(f => f.length));
  const cuerpo = filas.map((f, i) => {
    const r = i + 2;
    return `<row r="${r}">${f.map((v, c) => celda(colLetra(c) + r, v)).join('')}</row>`;
  }).join('');
  xml = xml.slice(0, ini) + apertura + fila1 + cuerpo + xml.slice(fin);
  xml = xml.replace(/<dimension ref="[^"]*"\/>/, `<dimension ref="A1:${colLetra(nCols - 1)}${Math.max(1, filas.length + 1)}"/>`);
  zip.file(hojas[HOJA_DATOS], xml);

  // 2) "Para woocommerce": si hay más datos que filas con fórmulas, copiar la última hacia abajo
  let extendidas = 0;
  if (hojas[HOJA_FORMULAS]) {
    let fx = await zip.file(hojas[HOJA_FORMULAS]).async('string');
    const filasF = [...fx.matchAll(/<row [^>]*r="(\d+)"/g)].map(m => Number(m[1]));
    const ultima = Math.max(...filasF);
    const necesarias = filas.length + 1;
    if (necesarias > ultima) {
      const plantillaFila = fx.match(new RegExp(`<row [^>]*r="${ultima}"[\\s\\S]*?</row>`))[0];
      const re = new RegExp(`([A-Z]{1,3}\\$?)${ultima}(?![0-9])`, 'g');
      let nuevas = '';
      for (let r = ultima + 1; r <= necesarias; r++) {
        nuevas += plantillaFila.replace(new RegExp(`(<row [^>]*?)r="${ultima}"`), `$1r="${r}"`)
          .replace(re, (m, col) => col.endsWith('$') ? m : col + r)
          .replace(/<v>[^<]*<\/v>|<v\/>/g, '<v/>');
        extendidas++;
      }
      const cierre = fx.indexOf('</sheetData>');
      fx = fx.slice(0, cierre) + nuevas + fx.slice(cierre);
      fx = fx.replace(/(<dimension ref="[A-Z]+\d+:[A-Z]+)\d+("\/>)/, `$1${necesarias}$2`)
             .replace(/(<autoFilter ref="[A-Z]+\d+:[A-Z]+)\d+(")/, `$1${necesarias}$2`);
      zip.file(hojas[HOJA_FORMULAS], fx);
    }
    // Quitar las filas de fórmulas que sobran (más allá de los datos): así "Para woocommerce"
    // tiene exactamente una fila por cada fila de "Sistema".
    if (necesarias < ultima) {
      fx = await zip.file(hojas[HOJA_FORMULAS]).async('string');
      fx = fx.replace(/<row [^>]*r="(\d+)"[^>]*>[\s\S]*?<\/row>|<row [^>]*r="(\d+)"[^>]*\/>/g,
        (m, a, b) => Number(a || b) > necesarias ? '' : m);
      zip.file(hojas[HOJA_FORMULAS], fx);
    }
    if (necesarias !== ultima) {
      fx = await zip.file(hojas[HOJA_FORMULAS]).async('string');
      fx = fx.replace(/(<dimension ref="[A-Z]+\d+:[A-Z]+)\d+("\/>)/, `$1${necesarias}$2`)
             .replace(/(<autoFilter ref="[A-Z]+\d+:[A-Z]+)\d+(")/, `$1${necesarias}$2`);
      zip.file(hojas[HOJA_FORMULAS], fx);
      let wb = await zip.file('xl/workbook.xml').async('string');
      wb = wb.replace(/(<definedName name="_xlnm\._FilterDatabase"[^>]*>[^<]*!\$[A-Z]+\$\d+:\$[A-Z]+\$)\d+/, `$1${necesarias}`);
      zip.file('xl/workbook.xml', wb);
    }
  }

  // 2b) Borrar los resultados guardados de las fórmulas (eran de los datos viejos de la
  //     plantilla) para que Excel / Google Sheets / LibreOffice las calculen con los nuevos.
  //     Las fórmulas en sí no se tocan.
  if (hojas[HOJA_FORMULAS]) {
    let fx = await zip.file(hojas[HOJA_FORMULAS]).async('string');
    fx = fx.replace(/(<f>[^<]*<\/f>)(<v>[^<]*<\/v>|<v\/>)/g, '$1');
    zip.file(hojas[HOJA_FORMULAS], fx);
  }

  // 3) Recalcular todo al abrir y quitar la cadena de cálculo vieja
  let wb = await zip.file('xl/workbook.xml').async('string');
  wb = wb.replace(/<calcPr([^>]*?)\/>/, (m, a) => `<calcPr${a.replace(/\s*fullCalcOnLoad="[^"]*"/, '')} fullCalcOnLoad="1"/>`);
  zip.file('xl/workbook.xml', wb);
  if (zip.file('xl/calcChain.xml')) {
    zip.remove('xl/calcChain.xml');
    let rels = await zip.file('xl/_rels/workbook.xml.rels').async('string');
    rels = rels.replace(/<Relationship [^>]*Target="calcChain\.xml"[^>]*\/>/, '');
    zip.file('xl/_rels/workbook.xml.rels', rels);
    let ct = await zip.file('[Content_Types].xml').async('string');
    ct = ct.replace(/<Override [^>]*PartName="\/xl\/calcChain\.xml"[^>]*\/>/, '');
    zip.file('[Content_Types].xml', ct);
  }
  const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return { buffer: out, extendidas };
}

module.exports = function registrarWoo({ app, authAdmin, requiereModulo, prodPool }) {
  const mAud = requiereModulo('auditoria');

  async function leer(vids) {
    const q = (sql, a) => prodPool.query(sql, a).then(r => r[0]);
    const [sel] = [await q(`SELECT DISTINCT product_id FROM product_variations WHERE id IN (?) AND deleted_at IS NULL`, [vids])];
    const pids = sel.map(r => r.product_id);
    if (!pids.length) throw new Error('No se encontraron los productos elegidos.');
    const [prods, vars, catsAll, asig, tags] = await Promise.all([
      q(`SELECT id, name, description, is_featured, woocommerce_id, sku_base, product_type FROM products WHERE id IN (?)`, [pids]),
      q(`SELECT id, product_id, TRIM(sku) AS sku, name, product_type, status, is_default, regular_price, sale_price,
                weight, length, width, height, woocommerce_id
           FROM product_variations WHERE deleted_at IS NULL AND product_id IN (?)`, [pids]),
      q(`SELECT id, name, parent_id FROM product_categories`),
      q(`SELECT product_id, product_category_id AS cid FROM product_product_category WHERE product_id IN (?)`, [pids]),
      q(`SELECT ppt.product_id, t.name FROM product_product_tag ppt JOIN product_tags t ON t.id = ppt.product_tag_id WHERE ppt.product_id IN (?)`, [pids]).catch(() => [])
    ]);
    const todas = vars.map(v => v.id);
    const [st, pvs, imgs, defs, vals] = await Promise.all([
      q(`SELECT product_variation_id AS vid, SUM(quantity) AS qty FROM location_stocks WHERE product_variation_id IN (?) GROUP BY product_variation_id`, [todas]),
      q(`SELECT product_variation_id AS vid, backorder_mode, low_stock_threshold FROM product_variation_stocks WHERE product_variation_id IN (?) ORDER BY id`, [todas]),
      q(`SELECT product_id, product_variation_id, path FROM product_images WHERE deleted_at IS NULL AND (product_id IN (?) OR product_variation_id IN (?))
          ORDER BY sort_order ASC, id ASC`, [pids, todas]),
      q(`SELECT ppa.product_id, pa.name, ppa.is_visible FROM product_product_attribute ppa JOIN product_attributes pa ON pa.id = ppa.product_attribute_id
          WHERE ppa.product_id IN (?)`, [pids]).catch(() => []),
      q(`SELECT pvav.product_variation_id AS vid, pa.name AS nombre, pav.value AS valor
           FROM product_variation_attribute_values pvav
           JOIN product_attribute_values pav ON pav.id = pvav.product_attribute_value_id
           JOIN product_attributes pa ON pa.id = pav.product_attribute_id
          WHERE pvav.product_variation_id IN (?) ORDER BY pvav.product_variation_id, pa.id`, [todas]).catch(() => [])
    ]);
    const byId = {}; catsAll.forEach(c => byId[c.id] = c);
    const ruta = id => { const p = []; let cur = id, g = 0; while (cur != null && byId[cur] && g++ < 12) { p.unshift(byId[cur].name); cur = byId[cur].parent_id; } return p.join(' > '); };
    const d = { prods: {}, vars, stock: {}, pvs: {}, cats: {}, tags: {}, imgProd: {}, imgVar: {}, attrVis: {}, attrVar: {} };
    prods.forEach(p => d.prods[p.id] = p);
    st.forEach(r => d.stock[r.vid] = Number(r.qty) || 0);
    pvs.forEach(r => { if (!d.pvs[r.vid]) d.pvs[r.vid] = r; });
    const cs = {}; asig.forEach(a => { const r = ruta(a.cid); if (r) (cs[a.product_id] = cs[a.product_id] || new Set()).add(r); });
    Object.keys(cs).forEach(k => d.cats[k] = [...cs[k]].join(', '));
    const ts = {}; tags.forEach(t => (ts[t.product_id] = ts[t.product_id] || []).push(t.name));
    Object.keys(ts).forEach(k => d.tags[k] = ts[k].join(', '));
    let sinUrl = 0;
    imgs.forEach(im => {
      if (!/^https?:\/\//i.test(txt(im.path))) { sinUrl++; return; }   // solo URLs completas
      if (im.product_variation_id != null) (d.imgVar[im.product_variation_id] = d.imgVar[im.product_variation_id] || []).push(im.path);
      else (d.imgProd[im.product_id] = d.imgProd[im.product_id] || []).push(im.path);
    });
    defs.forEach(a => (d.attrVis[a.product_id] = d.attrVis[a.product_id] || {})[a.name] = !!Number(a.is_visible));
    vals.forEach(a => (d.attrVar[a.vid] = d.attrVar[a.vid] || []).push(a));
    return { d, sinUrl };
  }

  app.post('/admin/auditoria/pendientes-woo-excel', authAdmin, mAud, async (req, res) => {
    try {
      const vids = [...new Set(((req.body && req.body.vids) || []).map(Number).filter(n => Number.isInteger(n) && n > 0))];
      if (!vids.length) return res.status(400).json({ error: 'No hay productos para exportar.' });
      if (vids.length > 5000) return res.status(400).json({ error: 'Máximo 5000 productos por archivo.' });
      if (!fs.existsSync(PLANTILLA)) return res.status(500).json({ error: 'Falta la plantilla plantillas/creacion-productos-woocommerce.xlsx en el servidor.' });
      const { d, sinUrl } = await leer(vids);
      const filas = armarFilas(d, vids);
      const { buffer, extendidas } = await llenarPlantilla(fs.readFileSync(PLANTILLA), filas);
      const fecha = new Date().toISOString().slice(0, 10);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="CREACION-PRODUCTOS-WOOCOMMERCE-${fecha}.xlsx"`);
      res.setHeader('X-Filas', String(filas.length));
      res.setHeader('X-Formulas-Extendidas', String(extendidas));
      res.setHeader('X-Imagenes-Sin-Url', String(sinUrl));
      res.send(buffer);
    } catch (e) { res.status(500).json({ error: 'No se pudo generar el Excel: ' + e.message }); }
  });
};

module.exports._test = { armarFilas, llenarPlantilla, colLetra, decimal };
