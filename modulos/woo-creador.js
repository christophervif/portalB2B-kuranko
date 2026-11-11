// ═══════════════════════════════════════════════════════════════════════════
//  MÓDULO: Creador WooCommerce (botón propio en el panel, permiso 'woo_creador')
//  Módulo propio (no depende de Bikes): repuestos, accesorios y ropa de una marca →
//  tu plantilla CREACIÓN PRODUCTOS WOOCOMMERCE lista para importar:
//
//   1) Importar: subes la lista de precios tal como la manda la marca (.xlsx/.csv).
//      Las columnas se reconocen por su nombre (si faltan las importantes, pregunta a la IA).
//   2) Nombre y categoría: cada fila se convierte a NUESTRO formato
//         Marca - Tipo - Descripción precisa - Información adicional - Variante
//      aprendiendo de los nombres que ya están en el ERP (marca escrita igual, mismos
//      tipos) y se asigna a una categoría EXISTENTE del ERP. Fuentes, de más a menos
//      segura: lo aprendido del catálogo (tipo → categoría), la IA (elige de la lista)
//      y palabras clave. Si no calza o hay duda → ALERTA para elegirla a mano o crear
//      una categoría nueva (queda marcada como nueva).
//   3) Lector: la ficha (descripción, especificaciones, fotos,
//      peso) se lee de la web de la marca: desde el servidor o con el marcador
//      «Lector Woo Kuranko» si la marca bloquea al portal.
//   4) Excel: llena la plantilla con las mismas filas que el exportador del ERP
//      (simple · variable + variaciones) — modulos/woo-creador-excel.js.
//
//  No escribe en el ERP (solo lo lee). Los lotes se guardan en la base del PORTAL
//  (tabla wc_lotes) para poder seguir otro día y para que el Lector los vea.
//  Permiso: 'woo_creador' (propio). Variables: GEMINI_API_KEY (sin ella funciona con reglas y lo
//  aprendido del catálogo) y WOO_GEMINI_MODEL (opcional). Apoyo: modulos/woo-creador-web.js
//
//  GET    /admin/woo-creador/contexto            categorías, marcas, tipos, atributos, TC
//  POST   /admin/woo-creador/mapear              { primeras:[[…]] } → encabezado + columnas
//  POST   /admin/woo-creador/procesar            { filas, opciones, archivo } → lote (IA en segundo plano)
//  GET    /admin/woo-creador/lotes               lista
//  GET    /admin/woo-creador/lote/:id            lote + avance de la IA
//  PUT    /admin/woo-creador/lote/:id            { cambios:[{k,…}], borrar:[k], opciones }
//  DELETE /admin/woo-creador/lote/:id
//  POST   /admin/woo-creador/lote/:id/ia         { ks:[…] } rehace nombre/categoría con IA
//  POST   /admin/woo-creador/lote/:id/emparejar  { links, origen } (Lector) → link de cada producto
//  POST   /admin/woo-creador/lote/:id/ficha      { k, url, imgs?, texto? } → descripción, fotos, peso
//  POST   /admin/woo-creador/lote/:id/excel      { ks?, incluir_alertas } → .xlsx
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const web = require('./woo-creador-web');
const woo = require('./woo-creador-excel');
const { catalogoSku } = require('./comunes');

const { leerPagina, fichaDeHtml, htmlATexto, elegirImagenes, EXCLUIR_IMG, aNumero, reconocerColumnas } = web;
const llamarGemini = (...a) => web.llamarGemini(...a);
const errorIA = () => web.ultimoError();

const num = v => { const n = Number(v); return isFinite(n) ? n : 0; };
const norm = s => String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
const txt = (v, n = 200) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
const palabras = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter(Boolean);
// singular simple para comparar (discos → disco, pastillas → pastilla, cubiertas → cubierta)
// (el «-es» solo se quita tras l, n, r, d, z, j: manillares → manillar, pistones → piston; guantes → guante)
const raiz = w => w.length > 4 && /[lnrdzj]es$/.test(w) ? w.slice(0, -2) : w.length > 3 && /s$/.test(w) && !/ss$/.test(w) ? w.slice(0, -1) : w;

// ── Columnas de la lista de la marca ──────────────────────────────────────────
// Sinónimos de los encabezados que usan las marcas (español, inglés, alemán).
const CAMPOS = {
  marca: ['marca', 'brand', 'manufacturer', 'fabricante', 'hersteller', 'marke'],
  nombre: ['nombre', 'name', 'descripcion', 'description', 'producto', 'product', 'productname', 'itemname', 'itemdescription', 'articulo', 'item', 'designation', 'bezeichnung', 'titulo', 'title', 'denominacion', 'artikelbezeichnung'],
  modelo: ['modelo', 'model', 'modelname', 'serie', 'series', 'line', 'linea', 'familia', 'family', 'collection', 'coleccion'],
  tipo: ['tipo', 'type', 'categoria', 'category', 'subcategoria', 'subcategory', 'productgroup', 'productcategory', 'grupo', 'group', 'segment', 'kategorie', 'warengruppe', 'productline', 'clase'],
  sku: ['sku', 'partnumber', 'partno', 'part', 'mpn', 'ref', 'referencia', 'code', 'codigo', 'articleno', 'articlenumber', 'artnr', 'artikelnummer', 'itemno', 'itemnumber', 'itemcode', 'productcode', 'codigoproveedor', 'vendorcode', 'modelnumber', 'pn'],
  ean: ['ean', 'upc', 'gtin', 'barcode', 'codigobarras', 'ean13', 'eancode', 'upccode'],
  talla: ['talla', 'size', 'tamano', 'grosse', 'groesse', 'sizes', 'tallas'],
  color: ['color', 'colour', 'farbe', 'colorway', 'colores', 'acabado', 'finish'],
  medida: ['medida', 'medidas', 'dimension', 'dimensions', 'diametro', 'diameter', 'length', 'largo', 'ancho', 'width', 'dientes', 'teeth', 'variante', 'variant', 'option', 'opcion'],
  costo: ['costo', 'cost', 'dealerprice', 'dealer', 'precioneto', 'net', 'netprice', 'wholesale', 'b2b', 'pvd', 'preciocompra', 'distributorprice', 'distributor', 'distribuidor', 'preciodistribuidor', 'ek', 'ekpreis', 'haendlerpreis', 'fob', 'unitcost', 'costounitario'],
  moneda: ['moneda', 'currency', 'divisa', 'curr', 'wahrung'],
  pvp: ['pvp', 'msrp', 'rrp', 'retail', 'retailprice', 'precioventa', 'pvpr', 'uvp', 'pvpsugerido', 'srp', 'precio', 'price', 'preciopublico', 'listprice', 'precioventapublico'],
  stock: ['stock', 'qty', 'quantity', 'cantidad', 'disponible', 'units', 'unidades', 'qtyavailable', 'inventory', 'bestand', 'existencias'],
  peso: ['peso', 'pesokg', 'weight', 'gewicht', 'weightkg', 'weightg', 'pesog', 'pesogr'],
  url_imagen: ['urlimagen', 'imagen', 'image', 'imageurl', 'foto', 'picture', 'bild', 'photo'],
  url_ficha: ['urlficha', 'ficha', 'link', 'url', 'specsheet', 'datasheet', 'productpage', 'productlink', 'producturl', 'web', 'website'],
  descripcion_larga: ['descripcionlarga', 'longdescription', 'fulldescription', 'details', 'detalle', 'detalles', 'caracteristicas', 'features', 'beschreibung', 'texto'],
  notas: ['notas', 'notes', 'nota', 'comentario', 'comments', 'bemerkung', 'observaciones']
};

// Al exportar no van categorías de estado (el stock y las reservas ya lo indican)
const CAT_ESTADO_EXPORT = /^(disponible\s*a\s*pedido|a\s*pedido|bajo\s*pedido|por\s*encargo|pre-?venta|pr[oó]ximamente(\s*en\s*llegar)?|rebajas|ofertas?|outlet|nuevo|novedades|uncategorized|sin\s*categor[ií]a)$/i;
// Categorías que en realidad son etiquetas o estados (no se eligen como categoría del producto)
const CATS_ESTADO = /^(rebajas|disponible a pedido|proximamente en llegar|uncategorized|sin categoria|marketplace|ofertas?|outlet|nuevo|novedades)$/i;
const CAT_A_PEDIDO = 'Disponible A pedido';
// Orden de los atributos en el nombre: primero color/acabado, luego medidas, la talla al final ("Azul - Talla L")
const ORDEN_ATTR = ['Color', 'Acabado', 'Modelo', 'Tipo', 'Medida', 'Medidas', 'Diámetro', 'Ancho', 'Largo', 'Longitud', 'Dientes', 'Tamaño', 'Talla', 'Tallas'];
const ordenAttr = k => { const i = ORDEN_ATTR.findIndex(x => norm(x) === norm(k)); return i < 0 ? 50 : i; };

// Palabras de la lista de la marca (o del nombre) → palabras de nuestras categorías.
// Solo ayudan cuando no hay nada aprendido del catálogo ni IA; las categorías siguen siendo las del ERP.
const SINONIMOS = {
  tire: 'cubierta', tyre: 'cubierta', llanta: 'cubierta', neumatico: 'cubierta', reifen: 'cubierta', tube: 'camara', schlauch: 'camara', innertube: 'camara',
  rotor: 'disco', disc: 'disco', bremsscheibe: 'disco', pad: 'pastilla', pads: 'pastilla', brakepad: 'pastilla', belag: 'pastilla',
  caliper: 'caliper', lever: 'maneta', brake: 'freno', bremse: 'freno', hose: 'funda', cable: 'cable', bleed: 'servicio',
  chain: 'cadena', kette: 'cadena', cassette: 'pinon', sprocket: 'pinon', cog: 'pinon', derailleur: 'descarrilador', schaltwerk: 'descarrilador',
  shifter: 'shifter', trigger: 'shifter', crank: 'biela', crankset: 'biela', chainring: 'plato', bottombracket: 'pedalier', bb: 'pedalier', pedal: 'pedal', cleat: 'cala',
  chainguide: 'guiacadena', bashguard: 'guiacadena',
  handlebar: 'manillar', bar: 'manillar', manubrio: 'manillar', stem: 'potencia', grip: 'puno', grips: 'puno', headset: 'direccion', spacer: 'espaciador', topcap: 'tapa',
  saddle: 'sillin', seat: 'sillin', seatpost: 'tija', dropper: 'tija', post: 'tija',
  fork: 'horquilla', gabel: 'horquilla', shock: 'shock', damper: 'shock', spring: 'muelle', airspring: 'muelle', remote: 'remoto', lockout: 'remoto',
  rim: 'aro', felge: 'aro', hub: 'maza', nabe: 'maza', spoke: 'radio', nipple: 'cabecilla', wheel: 'rueda', wheelset: 'rueda', axle: 'eje', thruaxle: 'eje',
  valve: 'valvula', sealant: 'liquido', tape: 'cinta', rimtape: 'cinta', insert: 'proteccion', pump: 'inflador', inflator: 'inflador', co2: 'inflador', gauge: 'medidor', patch: 'parche',
  helmet: 'casco', helm: 'casco', glove: 'guante', gloves: 'guante', handschuh: 'guante', jersey: 'jersey', polo: 'polo', shirt: 'polera', short: 'short', shorts: 'short',
  pant: 'pantalon', pants: 'pantalon', jacket: 'chaqueta', vest: 'chaleco', sock: 'media', socks: 'media', calcetin: 'media', shoe: 'zapatilla', shoes: 'zapatilla', schuh: 'zapatilla',
  goggle: 'goggle', goggles: 'goggle', glasses: 'gafa', sunglasses: 'gafa', knee: 'rodillera', kneepad: 'rodillera', elbow: 'codera', protector: 'protector', armor: 'protector',
  cap: 'gorra', hat: 'gorro', beanie: 'gorro', mask: 'mascara', bib: 'culote',
  bottle: 'bidon', cage: 'portabidon', bag: 'bolsa', backpack: 'mochila', hydration: 'mochila', light: 'iluminacion', lamp: 'iluminacion', computer: 'ciclocomputador', gps: 'gps',
  tool: 'herramienta', tools: 'herramienta', multitool: 'minitool', wrench: 'herramienta', stand: 'soporte', lube: 'lubricante', oil: 'lubricante', grease: 'lubricante', cleaner: 'limpieza',
  bolt: 'tornillo', screw: 'tornillo', hanger: 'patilla', derailleurhanger: 'patilla', bearing: 'rodamiento', framebearing: 'rodamiento', framesaver: 'proteccion', fender: 'guardabarro'
};

// ── Contexto del ERP (solo lectura, en caché 10 min) ──────────────────────────
//  categorias: [ruta] hojas utilizables · marcas: {norm → como la escribimos} ·
//  tipos: {norm(tipo) → {tipo, cats:{ruta:n}, n}} · ejemplos: nombres reales · atributos · skus
function rutasCategorias(filas) {
  const byId = {}; filas.forEach(c => byId[c.id] = c);
  const hijos = new Set(filas.filter(c => c.parent_id != null).map(c => String(c.parent_id)));
  const ruta = id => { const p = []; let cur = id, g = 0; while (cur != null && byId[cur] && g++ < 12) { p.unshift(String(byId[cur].name).trim()); cur = byId[cur].parent_id; } return p.join(' > '); };
  const todas = {}, hojas = [];
  for (const c of filas) {
    const r = ruta(c.id); todas[c.id] = r;
    if (!r || CATS_ESTADO.test(String(c.name).trim())) continue;
    if (!hijos.has(String(c.id)) && r.includes(' > ')) hojas.push(r);
  }
  return { todas, hojas: [...new Set(hojas)].sort((a, b) => a.localeCompare(b, 'es')) };
}

// Separa un nombre del catálogo en segmentos: "Shimano - Disco - SLX … - MKP" → marca, tipo, resto
function segmentos(nombre) {
  const s = String(nombre || '').split(/\s+-\s+/).map(x => x.trim()).filter(Boolean);
  return { marca: s[0] || '', tipo: s[1] || '', resto: s.slice(2) };
}

// Aprende del catálogo: cómo se escribe cada marca, qué tipos se usan y en qué categoría cae cada tipo
function aprender(productos, rutaDeCat, hojasSet) {
  const marcas = {}, tipos = {}, porTipo = {};
  for (const p of productos) {
    const sg = segmentos(p.name);
    if (!sg.marca || !sg.tipo || sg.tipo.length > 30) continue;
    const km = norm(sg.marca); if (km) { const m = marcas[km] = marcas[km] || {}; m[sg.marca] = (m[sg.marca] || 0) + 1; }
    const kt = norm(sg.tipo); // «Piñon» y «Piñón» cuentan como el mismo tipo
    if (!kt || /^\d/.test(kt)) continue;
    const t = tipos[kt] = tipos[kt] || { formas: {}, cats: {}, n: 0 };
    t.formas[sg.tipo] = (t.formas[sg.tipo] || 0) + 1; t.n++;
    for (const cid of p.cids || []) { const r = rutaDeCat[cid]; if (r && hojasSet.has(r)) t.cats[r] = (t.cats[r] || 0) + 1; }
    if (!/\bMKP\b/i.test(p.name) && (porTipo[kt] || []).length < 3) (porTipo[kt] = porTipo[kt] || []).push(p.name);
  }
  const masUsada = o => Object.entries(o).sort((a, b) => b[1] - a[1])[0];
  const marcasOut = {}; for (const [k, o] of Object.entries(marcas)) marcasOut[k] = masUsada(o)[0];
  const tiposOut = {};
  for (const [k, t] of Object.entries(tipos)) {
    const f = masUsada(t.formas)[0];
    tiposOut[k] = { tipo: f.charAt(0).toUpperCase() + f.slice(1), cats: t.cats, n: t.n };
  }
  // Ejemplos de nombres: uno o dos por tipo frecuente (sin los de Marketplace, que llevan estado de uso)
  const ejemplos = Object.entries(porTipo).sort((a, b) => (tipos[b[0]].n - tipos[a[0]].n)).slice(0, 45).flatMap(([, l]) => l.slice(0, 1));
  return { marcas: marcasOut, tipos: tiposOut, ejemplos, porTipo };
}

// Categorías de respaldo: la pestaña "Valores" de la plantilla (si no se puede leer el ERP)
async function categoriasDePlantilla() {
  try {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(woo.PLANTILLA);
    const ws = wb.getWorksheet('Valores'); if (!ws) return [];
    let col = 0; ws.getRow(1).eachCell((c, i) => { if (/^categor/i.test(String(c.value || ''))) col = i; });
    if (!col) return [];
    const set = new Set();
    ws.getColumn(col).eachCell((c, i) => { if (i > 1) String(c.value || '').split(',').map(x => x.trim()).filter(x => x.includes(' > ') && !CATS_ESTADO.test(x)).forEach(x => set.add(x)); });
    return [...set].sort((a, b) => a.localeCompare(b, 'es'));
  } catch (e) { return []; }
}

// ── Elegir categoría ──────────────────────────────────────────────────────────
// Devuelve { categoria, conf (0–1), fuente, sugerida, nota }
function porPalabras(texto, tipo, hojas) {
  const tok = new Set(palabras(texto).map(w => sinonimo(w) || w).map(raiz));
  const tokTipo = new Set(palabras(tipo).map(w => sinonimo(w) || w).map(raiz));
  let mejor = null, seg = 0;
  for (const h of hojas) {
    const partes = h.split(' > ');
    const hoja = palabras(partes[partes.length - 1]).filter(w => w.length > 2 && !['para', 'and', 'los', 'las', 'del'].includes(w)).map(raiz);
    const grupo = palabras(partes.slice(1, -1).join(' ')).map(raiz);
    if (!hoja.length) continue;
    let s = 0;
    for (const w of hoja) { if (tokTipo.has(w)) s += 3; else if (tok.has(w)) s += 1.2; }
    for (const w of grupo) if (tok.has(w) || tokTipo.has(w)) s += 0.5;
    s = s / Math.sqrt(hoja.length);
    if (!mejor || s > mejor.s) { seg = mejor ? mejor.s : 0; mejor = { h, s }; } else if (s > seg) seg = s;
  }
  if (!mejor || mejor.s < 1) return null;
  const conf = Math.min(0.7, 0.35 + (mejor.s >= 3 ? 0.25 : 0.1) + (mejor.s - seg >= 1 ? 0.1 : 0));
  return { categoria: mejor.h, conf, fuente: 'palabras' };
}
function porAprendido(tipo, ctx) {
  const t = ctx.tipos[norm(tipo)]; if (!t) return null;
  const tot = Object.values(t.cats).reduce((a, b) => a + b, 0); if (!tot) return null;
  const [cat, n] = Object.entries(t.cats).sort((a, b) => b[1] - a[1])[0];
  const share = n / tot;
  if (share < 0.5) return { categoria: cat, conf: 0.45, fuente: 'aprendido', nota: `«${t.tipo}» está repartido en varias categorías` };
  return { categoria: cat, conf: tot >= 3 && share >= 0.75 ? 0.9 : tot >= 2 ? 0.8 : 0.7, fuente: 'aprendido' };
}
function elegirCategoria(p, ctx, ia) {
  const hojas = ctx.categorias, set = ctx.catSet;
  const apr = p.tipo ? porAprendido(p.tipo, ctx) : null;
  const pal = porPalabras([p.tipo, p.descripcion, p.info, p.cat_lista].join(' '), p.tipo, hojas);
  const iaCat = ia && ia.categoria && set.has(ia.categoria) ? ia.categoria : null;
  const iaNueva = ia && !iaCat ? txt(ia.categoria_nueva || ia.categoria, 120) : '';
  const iaConf = ia ? Math.max(0, Math.min(1, num(ia.confianza) || 0.6)) : 0;
  if (iaCat && apr && apr.categoria === iaCat) return { categoria: iaCat, conf: Math.max(0.95, apr.conf), fuente: 'aprendido+ia' };
  if (apr && apr.conf >= 0.8) return { ...apr, nota: iaCat && iaCat !== apr.categoria ? `La IA sugería «${iaCat}»` : apr.nota };
  if (iaCat) {
    const coincide = pal && pal.categoria === iaCat;
    return { categoria: iaCat, conf: Math.min(0.9, iaConf * (coincide ? 1 : 0.85) + (coincide ? 0.1 : 0)), fuente: 'ia', nota: apr && apr.categoria !== iaCat ? `En el catálogo «${p.tipo}» suele ir en «${apr.categoria}»` : '' };
  }
  // la IA dijo que ninguna calza: mejor vacía (alerta + sugerida) que una adivinanza por palabras
  if (ia && !iaCat && iaNueva && !(apr && apr.conf >= 0.7)) return { categoria: '', conf: 0, fuente: '', sugerida: iaNueva, nota: apr ? `En el catálogo «${p.tipo}» va en «${apr.categoria}»` : pal ? `Por palabras podría ser «${pal.categoria}»` : '' };
  if (apr) return { ...apr, sugerida: iaNueva };
  if (pal) return { ...pal, sugerida: iaNueva };
  return { categoria: '', conf: 0, fuente: '', sugerida: iaNueva };
}

// ── Nombre con nuestro formato ────────────────────────────────────────────────
const limpiarSeg = s => String(s == null ? '' : s).replace(/\s+-\s+/g, ' ').replace(/\s*[–—]\s*/g, ' ').replace(/\s+/g, ' ').replace(/^[\s,;.\-]+|[\s,;\-]+$/g, '').trim();
function textoVariante(attrs) {
  return Object.entries(attrs || {}).filter(([, v]) => String(v || '').trim()).sort((a, b) => ordenAttr(a[0]) - ordenAttr(b[0]))
    .map(([k, v]) => /^tallas?$/i.test(k) && !/^talla/i.test(String(v)) ? `Talla ${String(v).trim()}` : estilo(String(v).trim())).join(' - ');
}
// Marca como la escribimos en el catálogo (Sram/SRAM: la forma más usada)
// Marca sin la línea de producto de la lista («SHIMANO SOFTGOODS» → Shimano)
const SUFIJO_MARCA = /\s+(soft\s*goods?|softgoods?|apparel|components?|componentes|accesorios|accessories|footwear|calzado|clothing|ropa|parts|bikes?|cycling|ciclismo|division|div\.?|europe|usa|inc\.?|ltd\.?|s\.?a\.?c?\.?|gmbh)$/i;
const quitarSufijoMarca = m => { let x = String(m || '').trim(), prev; do { prev = x; x = x.replace(SUFIJO_MARCA, '').trim(); } while (x !== prev && x); return x || String(m || '').trim(); };
const marcaCanonica = (m, ctx) => { const b = quitarSufijoMarca(m); return (ctx && (ctx.marcas[norm(b)] || ctx.marcas[norm(m)])) || estilo(txt(b, 60), true); };

// ── Mayúsculas: los nombres en estilo título, los códigos en mayúsculas ──
// Se aplica solo a segmentos escritos casi todo en MAYÚSCULAS (como vienen de las listas);
// lo que ya está en mayúsculas y minúsculas se respeta.
const SIGLAS = new Set(['xt', 'xtr', 'slx', 'grx', 'gs', 'sgs', 'ss', 'di2', 'mtb', 'boa', 'eur', 'ust', 'tr', 'tlr', 'exo', 'dd', 'cl', 'is', 'pm', 'bb', 'hg', 'ms', 'led', 'usb', 'gps', 'co2', 'xc', 'dh', 'am', 'emtb', 'ep8', 'ep6', 'gx', 'nx', 'sx', 'xx', 'xx1', 'x01', 'axs', 'udh', 'dub', 'xd', 'cx', 'rd', 'fd', 'st', 'br', 'bl', 'sm', 'sh', 'wh', 'cs', 'cn', 'fc', 'pd', 'rt', 'hb', 'fh', 'sp', 'ii', 'iii', 'iv', 'pro', 'kg', 'xs', 's', 'm', 'l', 'xl', 'xxl', 'xxxl', 'ml', 'l/xl', 's/m', 'm/l', 'e-bike', 'ebike', 'tpu', 'abs', 'pvc', 'cnc', 'n/a', 'ar', 'bmx', 'eps', 'mips', 'spf', 'uv', 'dpi', 'rpm', 'kmh', 'cm', 'mm', 'oz', 'lb']);
const MINUS = new Set(['de', 'del', 'la', 'las', 'el', 'los', 'y', 'e', 'o', 'u', 'a', 'al', 'en', 'con', 'sin', 'para', 'por', 'x', 'of', 'and', 'the', 'for', 'with']);
const UNIDADES = { mm: 'mm', cm: 'cm', kg: 'kg', g: 'g', gr: 'g', ml: 'ml', v: 'V', t: 'T', d: 'D' };
function estiloPalabra(w, i) {
  if (!/[a-záéíóúñü]/i.test(w)) return w;
  const low = w.toLowerCase();
  // con números: código (CS-M8000, 11V, 46D, 29x2.40) → mayúsculas; medida con unidad (180MM → 180mm)
  if (/\d/.test(w)) { const m = w.match(/^(\d+(?:[.,]\d+)?)(mm|cm|kg|g|gr|ml)$/i); return m ? m[1] + UNIDADES[m[2].toLowerCase()] : w.toUpperCase(); }
  if (/^[a-z]{1,4}-[a-z0-9]/i.test(w) || SIGLAS.has(low)) return w.toUpperCase();      // RD-R8000, SH-RX801, GS
  if (!/[aeiouáéíóú]/i.test(w) && w.length <= 4) return w.toUpperCase();              // siglas sin vocales (BB, RPM)
  if (i > 0 && MINUS.has(low)) return low;
  return low.charAt(0).toUpperCase() + low.slice(1);
}
function estilo(seg, forzar) {
  const t = String(seg || '');
  const letras = t.replace(/[^a-záéíóúñü]/gi, ''); if (!letras) return t;
  const mayus = letras.replace(/[^A-ZÁÉÍÓÚÑÜ]/g, '').length / letras.length;
  if (!forzar && mayus < 0.7) return t; // ya tiene mayúsculas y minúsculas: se respeta
  return t.split(/(\s+|\/(?=[a-z]{3,}))/i).map((w, i) => /^\s+$/.test(w) ? w : w.split(/(\(|\))/).map(x => estiloPalabra(x, i)).join('')).join('');
}
function armarNombre(p, variante = '') {
  const marca = limpiarSeg(estilo(quitarSufijoMarca(p.marca), true));
  let desc = limpiarSeg(estilo(p.descripcion));
  // sin repetir la marca ni el tipo al inicio de la descripción
  for (const x of [p.marca, p.tipo]) { const re = new RegExp('^' + String(x || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b\\s*', 'i'); if (x) desc = desc.replace(re, '').trim(); }
  const tipo = limpiarSeg(estilo(p.tipo));
  const yaEsta = x => new RegExp('(^|\\s)' + x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\s|$)', 'i').test(desc + ' ' + (p.info || ''));
  const vari = String(variante || '').split(/\s+-\s+/).map(x => limpiarSeg(estilo(x))).filter(x => x && !yaEsta(x)); // varias partes («Negro - Talla M»); sin repetir lo que ya dice el nombre
  return [marca, tipo ? tipo.charAt(0).toUpperCase() + tipo.slice(1) : '', desc, limpiarSeg(estilo(p.info)), ...vari].filter(Boolean).join(' - ').slice(0, 240);
}

// Sin IA: tipo = el primer tipo conocido que aparece en el nombre (en inglés también: Rotor → Disco, Glove → Guantes)
// o la columna «tipo» de la lista; el resto es la descripción.
const sinonimo = w => SINONIMOS[w] || SINONIMOS[w.replace(/s$/, '')] || '';
function buscarTipo(frase, ctx) {
  // tus traducciones primero: «Rotor = Disco»
  const tr = (ctx.trad || []).find(x => norm(x.de) === norm(frase)); if (tr && norm(tr.a) !== norm(frase)) { const t = buscarTipo(tr.a, ctx); if (t) return t; }
  const idx = ctx._raizTipos || (ctx._raizTipos = Object.fromEntries(Object.entries(ctx.tipos).filter(([, t]) => t.n >= 2).map(([k]) => [raiz(k), k])));
  const k = norm(frase); if (!k) return null;
  if (ctx.tipos[k] && ctx.tipos[k].n >= 2) return ctx.tipos[k].tipo;
  const r = idx[raiz(k)]; return r ? ctx.tipos[r].tipo : null;
}
const reFrase = ws => new RegExp('(^|[^a-z0-9áéíóúñü])' + ws.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^a-z0-9]+') + '(?=$|[^a-z0-9áéíóúñü])', 'i');
function nombreSinIA(f, ctx) {
  let base = txt(f.nombre || f.modelo || '', 300);
  if (f.modelo && f.nombre && !norm(f.nombre).includes(norm(f.modelo))) base = `${f.modelo} ${f.nombre}`;
  const ws = palabras(base);
  let tipo = '', quitar = null;
  // de derecha a izquierda: en inglés el sustantivo va al final («Disc Brake Caliper», «Ranger Glove»)
  for (let n = 3; n >= 1 && !tipo; n--) for (let i = ws.length - n; i >= 0 && !tipo; i--) {
    const frase = ws.slice(i, i + n);
    const t = buscarTipo(frase.join(' '), ctx) || (n === 1 && sinonimo(frase[0]) ? buscarTipo(sinonimo(frase[0]), ctx) : null);
    if (t) { tipo = t; quitar = frase; }
  }
  // tus traducciones de la sección «# Tipos» (Jersey = Polo), aunque ese tipo aún no exista en el catálogo
  if (!tipo) for (const x of (ctx.trad || []).filter(x => x.tipo)) { x.re.lastIndex = 0; if (x.re.test(base)) { tipo = x.a; quitar = palabras(x.de); break; } }
  if (!tipo && f.tipo) { const ft = palabras(f.tipo); tipo = buscarTipo(f.tipo, ctx) || (ft.length === 1 && sinonimo(ft[0]) && buscarTipo(sinonimo(ft[0]), ctx)) || (ft.length <= 3 ? txt(f.tipo, 40) : ''); }
  let desc = base;
  if (quitar) desc = desc.replace(reFrase(quitar), '$1 ');
  if (f.marca) desc = desc.replace(reFrase(palabras(f.marca)), '$1 ');
  // quitar de la descripción los valores de variante (van al final)
  for (const v of Object.values(f.attrs || {})) if (v && String(v).length > 1) desc = desc.replace(reFrase(palabras(v)), '$1 ');
  return { tipo, descripcion: limpiarSeg(traducir(desc, ctx.trad)), info: '' };
}

// ── Trabajar sin IA: traducciones (las mantienes tú) y variantes escritas en el nombre ──
// Formato: una por línea «Black = Negro». Se aplican palabra completa, sin importar mayúsculas.
// Si el lado derecho es un tipo que ya usas (Cubierta, Guantes…), también sirve para reconocer el tipo.
const TRAD_BASE = `# Colores
Black = Negro
White = Blanco
Red = Rojo
Blue = Azul
Navy = Azul marino
Green = Verde
Grey = Gris
Gray = Gris
Yellow = Amarillo
Orange = Naranja
Pink = Rosado
Purple = Morado
Brown = Marrón
Silver = Plateado
Gold = Dorado
Clear = Transparente
Olive = Verde oliva
Camo = Camuflado
# Posición y uso
Front = delantero
Rear = trasero
6-bolt = 6 tornillos
Links = eslabones
Left = izquierdo
Right = derecho
Pair = par
Men's = hombre
Mens = hombre
Women's = mujer
Womens = mujer
Youth = niño
Kids = niño
Short Sleeve = manga corta
Long Sleeve = manga larga
# Tipos (en inglés → como los llamamos; lo de esta sección también se usa como 2.º segmento del nombre)
Tire = Cubierta
Tyre = Cubierta
Tube = Cámara
Rotor = Disco
Brake Pads = Pastillas
Chain = Cadena
Cassette = Piñón
Glove = Guantes
Gloves = Guantes
Helmet = Casco
Saddle = Sillín
Grips = Puños
Pedals = Pedales
Jersey = Polo`;
const escRe = x => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function leerTraducciones(texto) {
  const pares = []; let esTipo = false;
  for (const l of String(texto || '').split(/\r?\n/)) {
    const t = l.trim(); if (!t) continue;
    if (t.startsWith('#')) { esTipo = /tipo/i.test(t); continue; } // la sección «# Tipos» marca tipos de producto
    const i = t.indexOf('='); if (i < 1) continue;
    const de = t.slice(0, i).trim(), a = t.slice(i + 1).trim();
    if (de && a) pares.push([de, a, esTipo]);
  }
  pares.sort((x, y) => y[0].length - x[0].length); // primero las frases más largas
  return pares.map(([de, a, tipo]) => ({ de, a, tipo, re: new RegExp('(^|[^\\p{L}\\p{N}])' + escRe(de) + '(?=$|[^\\p{L}\\p{N}])', 'giu') }));
}
function traducir(texto, trad) {
  let t = String(texto == null ? '' : texto);
  for (const x of trad || []) t = t.replace(x.re, (m, pre) => pre + x.a);
  return t;
}
// Medidas, tallas, dientes y colores escritos en el nombre de la marca
const COLORES = new Set(['negro', 'blanco', 'rojo', 'azul', 'azul marino', 'verde', 'gris', 'amarillo', 'naranja', 'rosado', 'morado', 'marron', 'plateado', 'dorado', 'transparente', 'verde oliva', 'camuflado',
  'black', 'white', 'red', 'blue', 'navy', 'green', 'grey', 'gray', 'yellow', 'orange', 'pink', 'purple', 'brown', 'silver', 'gold', 'clear', 'olive', 'camo']);
const RE_VAR = [
  { attr: 'Talla', re: /(^|[^\w.])(\d{2}(?:[.,]5)?)\s?(?:EUR|EU)\b\.?/i, val: m => m[2].replace(',', '.') }, // zapatillas: «43 EUR»
  { attr: 'Medida', re: /(^|[^\w.])(\d{2,4}(?:[.,]\d+)?)\s?mm\b/i, val: m => m[2].replace(',', '.') + ' mm' },
  { attr: 'Dientes', re: /(^|[^\w.])(\d{2})\s?(?:t|dientes|teeth)\b/i, val: m => m[2] + 'T' },
  { attr: 'Talla', re: /(^|[^\w/])(?:talla|size|sz)?\s*(XXS|XS|S\/M|M\/L|L\/XL|XXXL|XXL|2XL|3XL|XL|S|M|L)(?=$|[^\w/])/, val: m => m[2].toUpperCase() }
];
// solo = lista de atributos a sacar (todos si no se indica). Devuelve los valores y el texto sin ellos.
function variantesEnNombre(texto, solo) {
  const out = {}; let base = String(texto || '');
  for (const r of RE_VAR) { if ((solo && !solo.includes(r.attr)) || out[r.attr]) continue; const m = base.match(r.re); if (m) { out[r.attr] = r.val(m); base = base.replace(m[0], m[1] + ' '); } }
  if (!solo || solo.includes('Color')) {
    const ws = base.split(/\s+/);
    for (let n = 2; n >= 1 && !out.Color; n--) for (let i = 0; i + n <= ws.length && !out.Color; i++) {
      const f = ws.slice(i, i + n).join(' ');
      if (COLORES.has(f.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z ]/g, ''))) { out.Color = f; ws.splice(i, n, ''); }
    }
    base = ws.join(' ');
  }
  return { attrs: out, base: limpiarSeg(base) };
}
// Filas del mismo modelo que solo cambian en una medida / talla / color escrita en el nombre
// → esa parte pasa a ser la variante (así «Rotor 180mm» y «Rotor 203mm» quedan como un producto).
// Lo que no cambia entre filas (ej. todas «Negro») queda en la descripción. Una fila sola no se toca.
function variantesSinIA(filas, trad) {
  const grupos = new Map();
  for (const f of filas) {
    const v = variantesEnNombre(f.descripcion);
    const k = [f.marca, f.tipo, v.base, f.info].map(norm).join('|');
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k).push({ f, v });
  }
  for (const g of grupos.values()) {
    if (g.length < 2) continue;
    const claves = new Set(g.flatMap(x => Object.keys(x.v.attrs)));
    const cambian = [...claves].filter(a => new Set(g.map(x => norm(x.v.attrs[a] || ''))).size > 1);
    if (!cambian.length) continue;
    for (const { f } of g) {
      const v = variantesEnNombre(f.descripcion, cambian);
      for (const [a, val] of Object.entries(v.attrs)) if (!Object.keys(f.attrs).some(k => norm(k) === norm(a))) f.attrs[a] = a === 'Color' ? traducir(val, trad) : val;
      f.descripcion = v.base;
    }
  }
  return filas;
}

// ── Precio de venta (S/ con IGV) ──────────────────────────────────────────────
const OPC_BASE = { moneda: 'USD', tc_usd: 3.8, tc_eur: 4.4, modo_precio: 'pvp', factor_pvp: 1, margen: 35, importacion: 25, igv: 18, redondeo: '1', publicado: 1, a_pedido: true, marca: '', usar_ia: true };
function opcionesLimpias(o = {}) {
  const r = { ...OPC_BASE };
  for (const k of ['tc_usd', 'tc_eur', 'factor_pvp', 'margen', 'importacion', 'igv']) if (o[k] !== undefined && isFinite(+o[k]) && +o[k] >= 0) r[k] = +o[k];
  if (['USD', 'EUR', 'PEN'].includes(o.moneda)) r.moneda = o.moneda;
  if (['pvp', 'costo'].includes(o.modo_precio)) r.modo_precio = o.modo_precio;
  if (['0.1', '1', '5', '10', '9'].includes(String(o.redondeo))) r.redondeo = String(o.redondeo);
  if (o.publicado !== undefined) r.publicado = o.publicado ? 1 : 0;
  if (o.a_pedido !== undefined) r.a_pedido = !!o.a_pedido;
  if (o.usar_ia !== undefined) r.usar_ia = !!o.usar_ia;
  if (o.marca !== undefined) r.marca = txt(o.marca, 60);
  r.margen = Math.min(r.margen, 90);
  return r;
}
function redondear(v, modo) {
  if (!(v > 0)) return null;
  if (modo === '0.1') return Math.ceil(v * 10) / 10;
  if (modo === '9') return Math.max(9, Math.ceil((v + 1) / 10) * 10 - 1); // 123 → 129 · 120 → 129
  const m = num(modo) || 1; return Math.ceil(v / m) * m;
}
function precioVenta(v, op) {
  if (num(v.precio_manual) > 0) return { precio: num(v.precio_manual), como: 'manual' };
  const mon = v.moneda || op.moneda;
  const tc = mon === 'PEN' ? 1 : mon === 'EUR' ? op.tc_eur : op.tc_usd;
  if (op.modo_precio === 'pvp' && num(v.pvp) > 0) return { precio: redondear(num(v.pvp) * tc * op.factor_pvp, op.redondeo), como: 'pvp' };
  if (num(v.costo) > 0) return { precio: redondear(num(v.costo) * tc * (1 + op.importacion / 100) / (1 - op.margen / 100) * (1 + op.igv / 100), op.redondeo), como: 'costo' };
  if (num(v.pvp) > 0) return { precio: redondear(num(v.pvp) * tc * op.factor_pvp, op.redondeo), como: 'pvp' };
  return { precio: null, como: '' };
}

// ── Filas de la lista → productos (agrupa variantes) ─────────────────────────
function monedaDe(r, op) {
  const t = `${r.moneda || ''} ${r.costo || ''} ${r.pvp || ''}`;
  return /eur|€/i.test(t) ? 'EUR' : /s\/|pen|soles/i.test(t) ? 'PEN' : /usd|us\$|\$/i.test(t) ? 'USD' : op.moneda;
}
function pesoKg(v) {
  const s = String(v == null ? '' : v); const n = aNumero(s); if (!(n > 0)) return '';
  return /\bg\b|gr|gram/i.test(s) && !/kg/i.test(s) || n > 50 ? Math.round(n) / 1000 : Math.round(n * 1000) / 1000;
}
// Filas crudas (ya mapeadas por campo) → filas limpias
function limpiarFilas(crudas, op) {
  return crudas.map((r, i) => {
    const attrs = {};
    if (txt(r.color)) attrs.Color = txt(r.color, 60);
    if (txt(r.medida)) attrs.Medida = txt(r.medida, 60);
    if (txt(r.talla)) attrs.Talla = txt(r.talla, 20).toUpperCase().replace(/^SMALL$/, 'S').replace(/^MEDIUM$/, 'M').replace(/^LARGE$/, 'L');
    return {
      i, marca: quitarSufijoMarca(txt(r.marca || op.marca, 60)), nombre: txt(r.nombre, 300), modelo: txt(r.modelo, 120), tipo: txt(r.tipo, 80), sku: txt(r.sku, 80).replace(/\s+/g, ''),
      ean: String(r.ean == null ? '' : r.ean).replace(/\D/g, '').slice(0, 14), attrs, costo: Math.round(aNumero(r.costo) * 100) / 100, pvp: Math.round(aNumero(r.pvp) * 100) / 100,
      moneda: monedaDe(r, op), stock: r.stock === undefined || r.stock === '' ? null : Math.round(aNumero(r.stock)), peso: pesoKg(r.peso),
      url_imagen: /^https?:\/\//i.test(String(r.url_imagen || '')) ? String(r.url_imagen).trim().slice(0, 500) : '',
      url: /^https?:\/\//i.test(String(r.url_ficha || '')) ? String(r.url_ficha).trim().slice(0, 500) : '',
      desc_larga: txt(r.descripcion_larga, 3000), notas: txt(r.notas, 300)
    };
  }).filter(f => f.nombre || f.modelo || f.sku);
}

// Une las filas ya nombradas en productos: mismo Marca+Tipo+Descripción+Info → un producto variable
let seqK = 0;
const nuevaK = () => 'p' + Date.now().toString(36) + (seqK++).toString(36);
function agrupar(filasNombradas) {
  const grupos = new Map();
  for (const f of filasNombradas) {
    const key = [f.marca, f.tipo, f.descripcion, f.info].map(norm).join('|');
    let g = grupos.get(key);
    if (!g) {
      g = { k: nuevaK(), marca: f.marca, tipo: f.tipo, descripcion: f.descripcion, info: f.info, cat_lista: f.tipo_lista || '', url: f.url || '', ean: '',
        nombre_manual: false, categoria: '', cat_fuente: '', cat_conf: 0, cat_nueva: false, cat_sugerida: '', cat_nota: '',
        descripcion_html: f.desc_larga ? `<p>${escHtml(f.desc_larga)}</p>` : '', imagenes: f.url_imagen ? [f.url_imagen] : [], peso: f.peso || '',
        ficha: null, ia: f.ia ? { categoria: f.ia.categoria || '', categoria_nueva: f.ia.categoria_nueva || '', confianza: f.ia.confianza } : null, sin_ia: !f.ia, variantes: [], alertas: [] };
      grupos.set(key, g);
    }
    if (!g.url && f.url) g.url = f.url;
    if (f.url_imagen && !g.imagenes.includes(f.url_imagen)) g.imagenes.push(f.url_imagen);
    g.variantes.push({ k: g.k + 'v' + g.variantes.length, sku: f.sku, ean: f.ean, attrs: f.attrs || {}, costo: f.costo, pvp: f.pvp, moneda: f.moneda, stock: f.stock, fila: f.i + 1, peso: f.peso || '', precio_manual: null });
  }
  return [...grupos.values()];
}
const escHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ── Alertas de cada producto (se recalculan en cada guardado) ────────────────
//  nivel: 'critico' (no sale en el Excel salvo que lo pidas) · 'aviso' · 'info'
function revisar(p, ctx, lote) {
  const A = [], op = lote.opciones;
  const add = (t, nivel, msg) => A.push({ t, nivel, msg });
  // Nombre
  if (!txt(p.marca)) add('nombre', 'critico', 'Falta la marca');
  if (!txt(p.tipo)) add('nombre', 'critico', 'Falta el tipo de producto (2.º segmento del nombre)');
  if (!txt(p.descripcion)) add('nombre', 'critico', 'Falta la descripción precisa (3.er segmento)');
  if (txt(p.marca) && ctx.marcas && !ctx.marcas[norm(p.marca)]) add('nombre', 'info', `Marca «${p.marca}» nueva en el catálogo: revisa cómo se escribe`);
  if (p.tipo && ctx.tipos && !ctx.tipos[norm(p.tipo)]) add('nombre', 'info', `Tipo «${p.tipo}» no se usa aún en el catálogo`);
  if (p.sin_ia && !p.nombre_manual && op.usar_ia !== false) add('nombre', 'aviso', 'Nombre armado sin IA: revísalo');
  // Categoría
  if (!p.categoria) add('categoria', 'critico', (p.cat_sugerida ? `No calza en ninguna categoría. Sugerida (nueva): «${p.cat_sugerida}»` : 'No calza en ninguna categoría: elige una o crea una nueva') + (p.cat_nota ? ' · ' + p.cat_nota : ''));
  else if (p.cat_nueva || !ctx.catSet.has(p.categoria)) add('categoria', 'aviso', `Categoría NUEVA «${p.categoria}»: créala en el ERP; WooCommerce la creará al importar`);
  else if (p.cat_fuente !== 'manual' && p.cat_conf < 0.6) add('categoria', 'critico', `Categoría dudosa (${Math.round(p.cat_conf * 100)}%): confirma «${p.categoria}»${p.cat_nota ? ' · ' + p.cat_nota : ''}`);
  else if (p.cat_fuente !== 'manual' && p.cat_conf < 0.8) add('categoria', 'aviso', `Revisa la categoría (${Math.round(p.cat_conf * 100)}%)${p.cat_nota ? ' · ' + p.cat_nota : ''}`);
  // SKU, precio y variantes
  const vistos = new Set();
  for (const v of p.variantes) {
    const et = p.variantes.length > 1 ? ` (${textoVariante(v.attrs) || 'fila ' + v.fila})` : '';
    if (!v.sku) add('sku', 'critico', 'Falta el SKU / código de la marca' + et);
    else {
      const ks = v.sku.toLowerCase();
      if (vistos.has(ks)) add('sku', 'critico', `SKU repetido ${v.sku}` + et);
      vistos.add(ks);
      if ((lote._skusLote || {})[ks] > 1) add('sku', 'critico', `SKU ${v.sku} repetido en otro producto del lote`);
      const ex = ctx.skus && ctx.skus.get(ks);
      if (ex !== undefined) add('sku', 'critico', `El SKU ${v.sku} ya existe en el sistema: «${txt(ex, 90)}»`);
    }
    if (!(precioVenta(v, op).precio > 0)) add('precio', 'critico', 'Sin precio (falta costo o PVP)' + et);
  }
  if (p.variantes.length > 1) {
    const claves = p.variantes.map(v => textoVariante(v.attrs));
    if (claves.some(c => !c)) add('variante', 'critico', 'Hay variantes sin talla/color/medida que las diferencie');
    else if (new Set(claves.map(norm)).size < claves.length) add('variante', 'critico', 'Dos variantes tienen los mismos atributos');
  }
  const nuevosAttr = [...new Set(p.variantes.flatMap(v => Object.keys(v.attrs || {})))].filter(a => ctx.atributos.length && !ctx.atributos.some(x => norm(x) === norm(a)));
  if (nuevosAttr.length) add('variante', 'info', `Atributo nuevo en la web: ${nuevosAttr.join(', ')}`);
  // Ficha
  if (p.ficha && p.ficha.pn === 'sin_pn') add('ficha', 'aviso', 'La página no muestra el PN: confirma que la ficha sea de este producto');
  if (p.ficha && p.ficha.pn === 'distinto') add('ficha', 'critico', `La ficha es de otro PN (${p.ficha.pn_pagina}): revisa el link`);
  if (!String(p.descripcion_html || '').replace(/<[^>]+>/g, '').trim()) add('ficha', 'aviso', 'Sin descripción: tráela de la web de la marca');
  if (!(p.imagenes || []).length) add('ficha', 'aviso', 'Sin fotos');
  if (armarNombre(p, textoVariante((p.variantes[0] || {}).attrs)).length > 200) add('nombre', 'aviso', 'Nombre muy largo (más de 200 caracteres)');
  p.alertas = A;
  return p;
}
const nivelMax = p => (p.alertas || []).some(a => a.nivel === 'critico') ? 'critico' : (p.alertas || []).some(a => a.nivel === 'aviso') ? 'aviso' : (p.alertas || []).length ? 'info' : '';

// ── IA: nombres + categoría en tandas ────────────────────────────────────────
function promptNombres(filas, ctx, marcaLote) {
  const delaMarca = Object.values(ctx.porTipo || {}).flat().filter(n => norm(segmentos(n).marca) === norm(marcaLote)).slice(0, 10);
  const ejemplos = [...new Set([...delaMarca, ...ctx.ejemplos])].slice(0, 40);
  const tipos = Object.values(ctx.tipos).filter(t => t.n >= 2).sort((a, b) => b.n - a.n).slice(0, 120).map(t => t.tipo);
  return `Eres el encargado del catálogo de Kuranko, tienda de ciclismo en Perú (web WooCommerce).
Convierte cada fila de la lista de precios de la marca al nombre con NUESTRO formato, separado por " - ":
  Marca - Tipo - Descripción precisa - Información adicional - Variante
Reglas:
· tipo: qué es el producto, en español y singular, 1 a 3 palabras, con mayúscula inicial. Usa uno de nuestros tipos si calza: ${tipos.join(', ')}.
· descripcion: modelo / serie / código comercial y las medidas o specs que distinguen al producto (ej. "SLX SM-RT64 Center Lock 180mm"). No repitas la marca ni el tipo. No pongas la talla ni el color si cambian entre filas del mismo modelo.
· info: solo si aporta (delantero/trasero, compatibilidad, contenido del pack "(2 unid)", año). Si no, "".
· atributos: lo que cambia entre variantes del MISMO producto (filas con igual modelo): {"Talla":"L"} {"Color":"Negro"} {"Medida":"180 mm"}. Si la fila es un producto único, {}. Usa estos nombres de atributo si calzan: ${ctx.atributos.slice(0, 40).join(', ') || 'Talla, Color, Medida'}.
· Las filas del mismo producto deben tener EXACTAMENTE el mismo tipo, descripcion e info (solo cambian los atributos).
· Nunca uses " - " dentro de un campo. No inventes datos que no estén en la fila. Traduce al español lo que sea genérico (Tire → Cubierta), pero no los nombres de modelo.
· categoria: elige UNA de la lista, copiada EXACTA. Si ninguna calza, deja "" y propone en categoria_nueva una ruta nueva con el mismo estilo.
· confianza: 0 a 1, qué tan seguro estás de la categoría.
Ejemplos reales de nuestro catálogo:
${ejemplos.map(e => '- ' + e).join('\n')}
Categorías existentes:
${ctx.categorias.join('\n')}
Responde SOLO un JSON: [{"i":0,"tipo":"","descripcion":"","info":"","atributos":{},"categoria":"","categoria_nueva":"","confianza":0.8}]
FILAS:
${JSON.stringify(filas.map(f => { const o = { i: f.i, marca: f.marca }; for (const k of ['nombre', 'modelo', 'tipo', 'sku']) if (f[k]) o[k === 'tipo' ? 'tipo_en_lista' : k] = f[k]; if (Object.keys(f.attrs).length) o.columnas_variante = f.attrs; if (f.desc_larga) o.detalle = f.desc_larga.slice(0, 300); return o; }))}`;
}
function leerJSON(t) {
  const s = String(t || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try { return JSON.parse(s); } catch (e) {}
  const m = s.match(/\[[\s\S]*\]|\{[\s\S]*\}/); if (m) { try { return JSON.parse(m[0]); } catch (e) {} }
  return null;
}
async function nombrarConIA(filas, ctx, marcaLote) {
  const txtIA = await llamarGemini(promptNombres(filas, ctx, marcaLote), 0.1, 90000);
  const arr = leerJSON(txtIA);
  if (!Array.isArray(arr)) return { error: errorIA() || 'La IA no devolvió una lista' };
  const porI = {}; arr.forEach(x => { if (x && x.i != null) porI[x.i] = x; });
  return { porI };
}
// Aplica la respuesta de la IA (o el respaldo sin IA) a una fila
function nombrarFila(f, ctx, x) {
  const sin = nombreSinIA(f, ctx);
  const attrs = { ...f.attrs };
  if (x && x.atributos && typeof x.atributos === 'object') for (const [k, v] of Object.entries(x.atributos)) if (txt(v)) {
    const kk = ctx.atributos.find(a => norm(a) === norm(k)) || txt(k, 30).replace(/^./, c => c.toUpperCase());
    for (const a of Object.keys(attrs)) if (norm(a) === norm(kk)) delete attrs[a]; // la IA traduce («Black» → «Negro»)
    attrs[kk] = txt(v, 60);
  }
  if (!x) for (const k of Object.keys(attrs)) attrs[k] = traducir(attrs[k], ctx.trad);
  // el tipo se escribe como en el catálogo si ya existe
  const tipoIA = x && txt(x.tipo, 40);
  const tipo = tipoIA ? ((ctx.tipos[norm(tipoIA)] || {}).tipo || tipoIA) : sin.tipo;
  return { ...f, marca: marcaCanonica(f.marca, ctx), tipo, descripcion: x && txt(x.descripcion, 160) ? txt(x.descripcion, 160) : sin.descripcion,
    info: x ? txt(x.info, 100) : sin.info, attrs, tipo_lista: f.tipo, ia: x ? { categoria: txt(x.categoria, 150), categoria_nueva: txt(x.categoria_nueva, 150), confianza: num(x.confianza) } : null };
}
function aplicarCategoria(p, ctx) {
  if (p.cat_fuente === 'manual') return p;
  const c = elegirCategoria(p, ctx, p.ia);
  Object.assign(p, { categoria: c.categoria, cat_conf: c.conf, cat_fuente: c.fuente, cat_sugerida: c.sugerida || '', cat_nota: c.nota || '', cat_nueva: false });
  return p;
}

// ── Ficha desde la web de la marca (servidor o Lector) ───────────────────────
function promptFicha(p, texto, fotos) {
  return `Eres redactor de Kuranko, tienda de ciclismo en Perú. Con el texto de la página oficial del producto «${armarNombre(p)}»${p.variantes[0] && p.variantes[0].sku ? ` (código ${p.variantes[0].sku})` : ''}, responde SOLO JSON:
{"es_el_producto": true,
 "resumen": "2 a 4 frases en español neutro para vender, sin inventar nada que no esté en el texto",
 "especificaciones": [{"k": "Modelo", "v": "…"}],
 "peso_kg": 0.25,
 "fotos": [0, 3, 5],
 "descripcion_precisa": "modelo y specs que lo distinguen, sin marca ni tipo (solo si el texto lo precisa mejor que el nombre actual; si no, \"\")"}
· "es_el_producto": false si la página es de otro producto o es un listado.
· "especificaciones": hasta 12 filas cortas en español, SOLO datos técnicos del producto (Modelo, Medida, Material, Compatibilidad, Peso, Contenido…). Nada de teléfonos, televentas, precios, envíos ni datos de la tienda.
· "fotos": índices de la lista de FOTOS que muestran ESTE modelo, en todos sus colores (máx. 24, la principal primero). [] si no sabes.
FOTOS:
${fotos.map((u, i) => `${i}: ${u.split('?')[0].split('/').slice(-2).join('/')}`).join('\n') || '(ninguna)'}
TEXTO:
${texto}`;
}
// Sin IA: la descripción oficial de la página (JSON-LD / meta) o, si no hay, los párrafos del texto,
// y las especificaciones escritas como «Clave: valor» o en tablas.
const BASURA = /cookie|privacidad|privacy|newsletter|suscr|copyright|©|derechos reservados|carrito|cart|login|iniciar sesi|env[ií]o gratis|javascript|navegador|browser/i;
// Lo que no es dato técnico: contacto de la tienda, precios, envíos, códigos internos
const NO_TECNICO = /televenta|venta|whats ?app|tel[eé]fono|celular|llam[ae]|contacto|correo|e-?mail|horario|atenci[oó]n|direcci[oó]n|tienda|sucursal|local\b|delivery|env[ií]o|despacho|recojo|precio|stock|disponib|cuota|pago|tarjeta|c[oó]digo|^sku$|^pn$|^p\/n$|^ref|marca|categor[ií]a|compart|s[ií]guenos|redes|cup[oó]n|descuento|oferta|promoci/i;
const ES_CONTACTO = v => /(\+?\d[\d\s\-().]{7,}\d)/.test(v) && (v.replace(/\D/g, '').length >= 7 && v.replace(/[\d\s\-+().]/g, '').length < 4) || /@|https?:\/\/|www\./i.test(v);
const esTecnico = (k, v) => !NO_TECNICO.test(k) && !ES_CONTACTO(v) && !BASURA.test(k + ' ' + v) && !/(\+51|televenta|whats ?app)/i.test(v);
const TITULO_SPECS = /^(especificaciones|especificaciones t[eé]cnicas|caracter[ií]sticas|caracter[ií]sticas t[eé]cnicas|ficha t[eé]cnica|datos t[eé]cnicos|detalles t[eé]cnicos|specifications|tech(nical)? specs?|features|informaci[oó]n adicional)\s*:?$/i;
function fichaSinIA(p, texto, desc0) {
  const lineas = String(texto || '').split(/\n/).map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  // zona del producto: desde donde aparece el modelo o el código
  const claves = [p.descripcion, ...(p.variantes || []).map(v => v.sku)].map(x => String(x || '').split(' ')[0]).filter(x => x.length > 3).map(x => x.toLowerCase());
  let i0 = lineas.findIndex(l => claves.some(c => l.toLowerCase().includes(c))); if (i0 < 0) i0 = 0;
  const zona = lineas.slice(i0, i0 + 250);
  let resumen = String(desc0 || '').trim();
  if (resumen.length < 60) {
    const parr = zona.filter(l => l.length >= 70 && l.length <= 900 && /[.!]/.test(l) && !BASURA.test(l) && !/\t/.test(l) && !/televenta|whats ?app|\+51|post ?venta/i.test(l));
    resumen = parr.slice(0, 2).join(' ');
  }
  const specs = [], vistas = new Set();
  // si la página tiene una sección «Especificaciones» / «Características», se toma desde ahí
  const iT = zona.findIndex(l => TITULO_SPECS.test(l));
  for (const l of iT >= 0 ? zona.slice(iT + 1) : zona) {
    const m = l.match(/^([^:\t]{2,40}?)\s*(?::|\t)\s*([^\t]{1,140})$/);
    if (!m || BASURA.test(l) || /^https?$/i.test(m[1])) continue;
    const k = m[1].trim(), v = m[2].trim().replace(/\t/g, ' ');
    if (!/[a-záéíóúñ]/i.test(k) || vistas.has(k.toLowerCase()) || v.length < 1 || !esTecnico(k, v)) continue;
    vistas.add(k.toLowerCase()); specs.push({ k, v });
    if (specs.length >= 14) break;
  }
  // primer número con su unidad: «290 g (talla 42)» → 0.29 · «1,2 kg» → 1.2
  const peso = (() => { const s = specs.find(x => /^(peso|weight)/i.test(x.k)); if (!s) return ''; const m = s.v.match(/(\d+(?:[.,]\d+)?)\s*(kg|g|gr|grs|gramos)?\b/i); if (!m) return ''; const n = parseFloat(m[1].replace(',', '.')); return n > 0 ? (/^kg$/i.test(m[2] || '') || (!m[2] && n < 30) ? n : n / 1000) : ''; })();
  return { html: htmlDescripcion(txt(resumen, 900), specs), peso: peso > 0 && peso < 40 ? Math.round(peso * 1000) / 1000 : '' };
}
// Descripción en el mismo HTML que usan los productos actuales (párrafo + «Especificaciones:» en lista)
function htmlDescripcion(resumen, specs) {
  let h = resumen ? `<p>${escHtml(resumen)}</p>` : '';
  const sp = (specs || []).filter(s => s && txt(s.k) && txt(s.v));
  if (sp.length) h += '<p><strong>Especificaciones:</strong></p><ul>' + sp.map(s => `<li><p>${escHtml(txt(s.k, 40))}: ${escHtml(txt(s.v, 200))}</p></li>`).join('') + '</ul>';
  return h;
}
async function fichaDeTexto(p, url, texto, imgs) {
  const cand = [...new Set((imgs || []).map(String).filter(u => /^https?:\/\//i.test(u) && !EXCLUIR_IMG.test(u)))];
  let fotos = elegirImagenes(cand, url); if (fotos.length < 2) fotos = cand;
  fotos = fotos.slice(0, 40);
  const t = String(texto || '');
  // el trozo con el código o el modelo suele ser el bueno
  const clave = [p.variantes[0] && p.variantes[0].sku, p.descripcion].filter(Boolean).map(x => String(x).split(' ')[0]).find(x => x.length > 2 && t.includes(x));
  const i0 = clave ? Math.max(0, t.indexOf(clave) - 2500) : Math.min(2500, t.length / 5);
  const trozo = t.slice(i0, i0 + 12000);
  const r = leerJSON(await llamarGemini(promptFicha(p, trozo, fotos), 0.2, 60000));
  if (!r || typeof r !== 'object') return { ok: false, error: errorIA() || 'La IA no respondió', pool: fotos };
  if (r.es_el_producto === false) return { ok: false, error: 'La página no parece ser de este producto', fotos: [] };
  const idx = (Array.isArray(r.fotos) ? r.fotos : []).map(Number).filter(i => Number.isInteger(i) && fotos[i]);
  return { ok: true, html: htmlDescripcion(txt(r.resumen, 900), (Array.isArray(r.especificaciones) ? r.especificaciones : []).filter(x => x && esTecnico(String(x.k || ''), String(x.v || ''))).slice(0, 14)),
    pool: idx.length ? idx.map(i => fotos[i]) : fotos, peso: num(r.peso_kg) > 0 && num(r.peso_kg) < 40 ? Math.round(num(r.peso_kg) * 1000) / 1000 : '',
    descripcion_precisa: txt(r.descripcion_precisa, 160) };
}

// Ficha de una página: con IA si se puede, si no con reglas (descripción, especificaciones, fotos, peso)
async function armarFicha(p, url, texto, html, imgs, usarIA) {
  let desc0 = '', todas = [...(imgs || [])];
  if (html) { const f = fichaDeHtml(html, url); desc0 = f.descripcion || ''; todas = [...todas, ...(f.imagenes || [])]; }
  let r = usarIA ? await fichaDeTexto(p, url, texto, todas) : { ok: false, error: 'IA apagada' };
  if (!r.ok) {
    const s = fichaSinIA(p, texto, desc0);
    const cand = [...new Set(todas.map(String).filter(u => /^https?:\/\//i.test(u) && !EXCLUIR_IMG.test(u)))];
    let pool = elegirImagenes(cand, url); if (pool.length < 2) pool = cand;
    r = { ...r, html: s.html, peso: s.peso, pool: r.pool && r.pool.length ? r.pool : pool.slice(0, 40) };
  }
  return r;
}

// ── ¿La página es realmente de este producto? (PN / código de la marca) ─────
// ok: el SKU aparece en la página · parecido: mismo modelo, otra talla/color (comparten página)
// distinto: la página muestra otro PN → no se guarda · sin_pn: la página no muestra ninguno
const RE_PN = /\b(?:P\/?N|part\s*(?:number|no\.?)|mpn|sku|c[oó]digo(?:\s+de\s+(?:producto|fabricante))?|ref(?:erencia)?|model\s*(?:no\.?|number)|art(?:[íi]culo|\.)?\s*(?:no\.?|nr\.?)?)\s*[:#.]?\s*([A-Z0-9][A-Z0-9\-_.\/]{4,40})/gi;
function pnsDePagina(texto, html) {
  const out = [];
  const add = (x, prio) => { x = String(x || '').trim().replace(/[.\/]+$/, ''); if (x.length >= 5 && /\d/.test(x) && /[a-z]/i.test(x) && !out.some(o => o.pn === x)) out.push({ pn: x, prio }); };
  for (const m of String(texto || '').matchAll(RE_PN)) add(m[1], /^(p\/?n|part|mpn)/i.test(m[0]) ? 0 : 1);
  for (const m of String(html || '').matchAll(/"(?:sku|mpn|productID)"\s*:\s*"([^"]{5,40})"/gi)) add(m[1], 0);
  return out.sort((a, b) => a.prio - b.prio).map(o => o.pn);
}
function verificarPN(p, texto, html) {
  const skus = [...new Set((p.variantes || []).map(v => norm(v.sku)).filter(x => x.length >= 5))];
  if (!skus.length) return { estado: 'sin_sku' };
  const plano = norm(String(texto || '')) + ' ' + norm(String(html || '').slice(0, 3e6));
  const v = skus.find(x => plano.includes(x)); if (v) return { estado: 'ok', pn: v.toUpperCase() };
  const pns = pnsDePagina(texto, html);
  // mismo modelo en otra talla o color (comparten página): mismo inicio largo
  const comun = (a, b) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return i; };
  for (const pn of pns) { const n = norm(pn); if (skus.some(x => comun(x, n) >= Math.max(8, Math.min(x.length, n.length) * 0.7))) return { estado: 'parecido', pn }; }
  if (pns.length) return { estado: 'distinto', pn: pns[0] };
  return { estado: 'sin_pn' };
}
// Fotos que no son del producto: logos, sellos, banners, redes, secciones generales del sitio
const FOTO_BASURA = /logo|sello|seal|badge|promo|banner|slider|wysiwyg|\/demo\/|\/home\/|youtube|\byt\b|whats ?app|facebook|instagram|tiktok|twitter|linkedin|pinterest|icon|payment|pago|visa|mastercard|amex|yape|plin|envio|delivery|garantia|placeholder|sprite|flag|footer|header|menu|newsletter|avatar|rating|estrella|star|loader|spinner|libro.?de.?reclamaciones|reclamo/i;
function limpiarFotos(pool, p) {
  const ruta = u => { let x = String(u).split('?')[0]; try { x = decodeURIComponent(x); } catch (e) {} return x.toLowerCase(); };
  let l = pool.filter(u => !FOTO_BASURA.test(ruta(u).replace(/^https?:\/\/[^/]+/, '')));
  // las que llevan el código del producto en el archivo, si hay
  const skus = (p.variantes || []).map(v => norm(v.sku)).filter(x => x.length >= 6);
  const conPN = l.filter(u => skus.some(s => norm(ruta(u)).includes(s.slice(0, Math.max(6, s.length - 4)))));
  if (conPN.length) return conPN;
  // si no, las de la galería de productos de la tienda
  const galeria = l.filter(u => /\/(catalog\/product|products?|productos?|media\/catalog|images\/products?|uploads\/\d{4})\//i.test(ruta(u)));
  return galeria.length ? galeria : l;
}

// ── Fotos de cada color ───────────────────────────────────────────────────────
// La página de la marca suele mostrar todos los colores juntos. Se eligen las fotos del color:
//  1) por el código del SKU dentro del archivo de la foto (ESHRX801MCL01… → …ESHRX801MCL01_1.png)
//  2) por el color escrito en el archivo (Negro ↔ black, con tus traducciones)
// Si nada distingue a unas fotos de otras, se quedan todas.
function colorDe(p, v) {
  const a = Object.entries((v || {}).attrs || {}).find(([k]) => /^(color|colour|acabado)$/i.test(k));
  return a ? a[1] : (variantesEnNombre(p.descripcion, ['Color']).attrs.Color || variantesEnNombre(p.info, ['Color']).attrs.Color || '');
}
function terminosColor(color, trad) {
  const c = norm(color); if (!c) return [];
  const t = new Set([c]);
  for (const x of trad || []) { if (norm(x.a) === c) t.add(norm(x.de)); if (norm(x.de) === c) t.add(norm(x.a)); }
  return [...t].filter(x => x.length >= 3);
}
// minúsculas y separadores como «_», igual para el archivo y el SKU (27162-001-M ↔ 27162_001_blk.jpg)
const plano_ = x => String(x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const archivo = u => { let x = String(u).split('?')[0].split('/').slice(-2).join('/'); try { x = decodeURIComponent(x); } catch (e) {} return plano_(x); };
function fotosDelColor(fotos, color, skus, trad) {
  if (fotos.length < 2) return fotos;
  const F = fotos.map(u => ({ u, n: archivo(u) }));
  const parte = l => l.length && l.length < F.length;
  for (const sku of [...new Set((skus || []).map(plano_))].filter(x => x.length >= 6)) {
    for (let n = sku.length; n >= 6; n--) {
      const pre = sku.slice(0, n); if (!/[a-z0-9]$/.test(pre)) continue;
      const re = new RegExp(pre + '(?![a-z0-9])'); // el código termina donde termina en el archivo (…MCL01_side, no …MCL01S)
      const l = F.filter(x => re.test(x.n));
      if (l.length) { if (parte(l)) return l.map(x => x.u); break; } // el código más largo que aparece; si está en todas, no distingue
    }
  }
  const ts = terminosColor(color, trad);
  if (ts.length) { const l = F.filter(x => ts.some(t => norm(x.n).includes(t))); if (parte(l)) return l.map(x => x.u); }
  return fotos;
}
// Reparte las fotos leídas: un solo color → las de ese color al producto;
// varios colores → todas al producto y a cada variante las de su color.
function asignarFotos(p, pool, trad) {
  if (!pool.length) return;
  const colores = new Set(p.variantes.map(v => norm(colorDe(p, v))).filter(Boolean));
  if (colores.size > 1) {
    p.imagenes = pool.slice(0, 10);
    for (const v of p.variantes) { const f = fotosDelColor(pool, colorDe(p, v), [v.sku], trad); v.imagenes = f.length < pool.length ? f.slice(0, 8) : []; }
  } else p.imagenes = fotosDelColor(pool, colorDe(p, p.variantes[0]), p.variantes.map(v => v.sku), trad).slice(0, 8);
}

// ── Filas para la plantilla (mismo formato que el exportador del ERP) ────────
function skuPadre(p) {
  const skus = p.variantes.map(v => v.sku).filter(Boolean);
  if (p.sku_base) return p.sku_base;
  if (!skus.length) return '';
  let pre = skus[0]; for (const s of skus) while (pre && !s.startsWith(pre)) pre = pre.slice(0, -1);
  pre = pre.replace(/[-_.\s]+$/, '');
  return pre.length >= 4 && !skus.includes(pre) ? pre : skus[0] + '-P';
}
function filasExcel(productos, lote) {
  const op = lote.opciones, filas = [], fs_ = woo.filaSistema, dec = woo.decimal;
  // sin categorías de estado (Disponible A pedido, Próximamente, Rebajas…): solo la categoría del producto
  const cats = p => String(p.categoria || '').split(',').map(x => x.trim()).filter(x => x && !CAT_ESTADO_EXPORT.test(x.split(' > ').pop()) && !/a\s*pedido/i.test(x)).join(', ');
  const imgs = l => [...new Set((l || []).filter(u => /^https?:\/\//i.test(u)))].join(', ');
  const comun = { publicado: op.publicado ? 1 : 0, destacado: 0, visibilidad: 'visible', existencias: 0, inventario: 0, bajo: '', reservas: 'notify', longitud: '', anchura: '', altura: '', rebajado: '', etiquetas: '' };
  for (const p of productos) {
    const vs = p.variantes;
    if (vs.length === 1) {
      const v = vs[0];
      const attr = Object.entries(v.attrs || {}).filter(([, x]) => txt(x)).map(([k, x]) => ({ nombre: k, valores: [txt(x, 60)], visible: true }));
      filas.push(fs_({ ...comun, id: '', tipo: 'simple', sku: v.sku, gtin: v.ean || '', nombre: armarNombre(p, textoVariante(v.attrs)), descripcion: p.descripcion_html || '',
        peso: dec(v.peso || p.peso), normal: dec(precioVenta(v, op).precio), categorias: cats(p), imagenes: imgs([...(v.imagenes || []), ...(p.imagenes || [])]), superior: '' }).concat(woo.atributos(attr)));
      continue;
    }
    const padre = skuPadre(p);
    const union = {};
    vs.forEach(v => Object.entries(v.attrs || {}).forEach(([k, x]) => { if (!txt(x)) return; const u = union[k] = union[k] || { nombre: k, valores: [], visible: true }; if (!u.valores.includes(txt(x, 60))) u.valores.push(txt(x, 60)); }));
    const ordenUnion = Object.values(union).sort((a, b) => ordenAttr(a.nombre) - ordenAttr(b.nombre));
    filas.push(fs_({ ...comun, id: '', tipo: 'variable', sku: padre, gtin: '', nombre: armarNombre(p), descripcion: p.descripcion_html || '',
      peso: dec(p.peso || vs[0].peso), normal: '', categorias: cats(p), imagenes: imgs([...(p.imagenes || []), ...vs.flatMap(v => v.imagenes || [])]), superior: '' }).concat(woo.atributos(ordenUnion)));
    for (const v of vs) {
      const attr = ordenUnion.map(u => ({ nombre: u.nombre, valores: [txt((v.attrs || {})[u.nombre], 60)].filter(Boolean), visible: true })).filter(a => a.valores.length);
      filas.push(fs_({ ...comun, id: '', tipo: 'variation', sku: v.sku, gtin: v.ean || '', nombre: armarNombre(p, textoVariante(v.attrs)), descripcion: '',
        peso: dec(v.peso || p.peso), normal: dec(precioVenta(v, op).precio), categorias: '', etiquetas: '', imagenes: imgs(v.imagenes), superior: padre }).concat(woo.atributos(attr)));
    }
  }
  return filas.map(f => f.map(woo.nl));
}

// ── Emparejar links de la web de la marca con los productos (Lector) ─────────
const IGNORAR = new Set(['www', 'http', 'https', 'com', 'es', 'en', 'de', 'html', 'php', 'product', 'products', 'producto', 'productos', 'shop', 'tienda', 'store', 'p', 'item', 'collections', 'category', 'the', 'and', 'for', 'with', 'mm']);
const tokens = s => palabras(s).filter(w => !IGNORAR.has(w) && (w.length > 1 || /\d/.test(w)));
function emparejar(productos, links) {
  const L = links.map(u => { let path = u; try { path = decodeURIComponent(new URL(u).pathname); } catch (e) {} return { u, t: new Set(tokens(path)), plano: norm(path) }; })
    .filter(l => l.t.size >= 1);
  const pares = {};
  for (const p of productos) {
    const skus = p.variantes.map(v => norm(v.sku)).filter(s => s.length >= 5);
    let mejor = null;
    for (const l of L) {
      let s = 0;
      if (skus.some(s0 => l.plano.includes(s0))) s += 10;
      const pt = tokens(`${p.descripcion} ${p.info}`); const pt2 = tokens(p.tipo);
      if (pt.length) { const hit = pt.filter(w => l.t.has(w)).length; s += hit / pt.length * 4 + (hit >= 2 ? 1 : 0); }
      if (pt2.some(w => l.t.has(w) || l.t.has(SINONIMOS[w] || ''))) s += 0.5;
      if (!mejor || s > mejor.s) mejor = { u: l.u, s };
    }
    if (mejor && mejor.s >= 3) pares[p.k] = mejor.u;
  }
  return pares;
}

module.exports = function registrarWooCreador({ app, authAdmin, requiereModulo, prodPool, portalPool }) {
  const mAud = requiereModulo('woo_creador');
  const usuarioDe = req => String((req.admin && req.admin.usuario) || 'admin').slice(0, 80);

  // ── Tabla de lotes (base del portal) ──
  let tablas = null;
  const prepararTablas = () => tablas || (tablas = portalPool.query(`CREATE TABLE IF NOT EXISTS wc_lotes (
      id INT AUTO_INCREMENT PRIMARY KEY, nombre VARCHAR(200), marca VARCHAR(80), datos LONGTEXT,
      usuario VARCHAR(80), creado DATETIME DEFAULT CURRENT_TIMESTAMP, actualizado DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) DEFAULT CHARSET=utf8mb4`).then(() => portalPool.query(`CREATE TABLE IF NOT EXISTS wc_ajustes (
      clave VARCHAR(40) PRIMARY KEY, valor LONGTEXT, actualizado DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) DEFAULT CHARSET=utf8mb4`)).catch(e => { tablas = null; throw e; }));
  // Traducciones (para trabajar sin IA): una sola lista para todas las marcas, en caché hasta que se guarde
  let tradCache = null;
  async function traduccionesTexto() {
    if (tradCache) return tradCache.texto;
    let texto = TRAD_BASE;
    try { await prepararTablas(); const [[r]] = await portalPool.query("SELECT valor FROM wc_ajustes WHERE clave='traducciones'"); if (r && r.valor != null) texto = r.valor; } catch (e) {}
    tradCache = { texto, lista: leerTraducciones(texto) };
    return texto;
  }
  async function leerLote(id) {
    await prepararTablas();
    const [[r]] = await portalPool.query('SELECT id, nombre, marca, datos, usuario, creado, actualizado FROM wc_lotes WHERE id=?', [num(id)]);
    if (!r) throw Object.assign(new Error('No existe ese lote'), { status: 404 });
    let d = {}; try { d = JSON.parse(r.datos || '{}'); } catch (e) {}
    return { id: r.id, nombre: r.nombre, marca: r.marca, usuario: r.usuario, creado: r.creado, actualizado: r.actualizado, opciones: opcionesLimpias(d.opciones), productos: Array.isArray(d.productos) ? d.productos : [], mapa: d.mapa || null };
  }
  // Cola por lote: guardados del panel, del Lector y de la IA no se pisan entre sí
  const colas = new Map();
  function enCola(id, fn) {
    const prev = colas.get(id) || Promise.resolve();
    const p = prev.catch(() => {}).then(fn);
    colas.set(id, p.finally(() => { if (colas.get(id) === p) colas.delete(id); }));
    return p;
  }
  async function guardarLote(L) {
    await portalPool.query('UPDATE wc_lotes SET nombre=?, marca=?, datos=? WHERE id=?',
      [txt(L.nombre, 200), txt(L.marca, 80), JSON.stringify({ opciones: L.opciones, productos: L.productos, mapa: L.mapa }), L.id]);
  }
  // Alertas al día (necesitan el contexto del ERP)
  function revisarLote(L, ctx) {
    const cuenta = {}; L.productos.forEach(p => p.variantes.forEach(v => { if (v.sku) { const k = v.sku.toLowerCase(); cuenta[k] = (cuenta[k] || 0) + 1; } }));
    // repetido en OTRO producto: se cuenta una vez por producto
    const porProd = {}; L.productos.forEach(p => new Set(p.variantes.map(v => (v.sku || '').toLowerCase()).filter(Boolean)).forEach(k => porProd[k] = (porProd[k] || 0) + 1));
    L._skusLote = porProd; L._catAPedido = ctx.catAPedido;
    L.productos.forEach(p => revisar(p, ctx, L));
    delete L._skusLote;
    return L;
  }
  const vista = L => ({ ...L, resumen: resumenLote(L), productos: L.productos.map(p => ({ ...p, _nombre: armarNombre(p, p.variantes.length === 1 ? textoVariante(p.variantes[0].attrs) : ''), _nivel: nivelMax(p),
    _sku_padre: p.variantes.length > 1 ? skuPadre(p) : '', variantes: p.variantes.map(v => { const pr = precioVenta(v, L.opciones); return { ...v, _precio: pr.precio, _como: pr.como, _nombre: armarNombre(p, textoVariante(v.attrs)) }; }) })) });
  const resumenLote = L => {
    const ps = L.productos;
    return { productos: ps.length, variantes: ps.reduce((a, p) => a + p.variantes.length, 0), criticos: ps.filter(p => nivelMax(p) === 'critico').length,
      categoria: ps.filter(p => p.alertas.some(a => a.t === 'categoria' && a.nivel === 'critico')).length, cat_nuevas: ps.filter(p => p.alertas.some(a => a.t === 'categoria' && /NUEVA/.test(a.msg))).length,
      sin_ficha: ps.filter(p => p.alertas.some(a => a.t === 'ficha')).length, listos: ps.filter(p => nivelMax(p) !== 'critico').length };
  };

  // ── Contexto del ERP ──
  let ctxCache = null, ctxProm = null;
  // Contexto del ERP + tus traducciones
  async function contexto(fresco) {
    const c = await contextoErp(fresco);
    await traduccionesTexto(); c.trad = tradCache.lista;
    return c;
  }
  async function contextoErp(fresco) {
    if (!fresco && ctxCache && Date.now() - ctxCache.t < 10 * 60e3) return ctxCache;
    if (ctxProm) return ctxProm;
    ctxProm = (async () => {
      const q = (sql, a) => prodPool.query(sql, a).then(r => r[0]);
      let cats = [], prods = [], asig = [], attrs = [], bases = [], fuente = 'erp', aviso = '';
      try {
        cats = await q('SELECT id, name, parent_id FROM product_categories WHERE deleted_at IS NULL').catch(() => q('SELECT id, name, parent_id FROM product_categories'));
        [prods, asig, attrs, bases] = await Promise.all([
          q('SELECT id, name FROM products WHERE deleted_at IS NULL'),
          q('SELECT product_id, product_category_id AS cid FROM product_product_category'),
          q('SELECT DISTINCT name FROM product_attributes').catch(() => []),
          q(`SELECT TRIM(sku_base) AS sku, name FROM products WHERE deleted_at IS NULL AND sku_base IS NOT NULL AND sku_base <> ''`).catch(() => [])
        ]);
      } catch (e) { fuente = 'plantilla'; aviso = 'No se pudo leer el ERP (' + e.message + '): se usan las categorías de la plantilla y no se revisan SKUs repetidos.'; }
      const { todas, hojas } = rutasCategorias(cats);
      let categorias = hojas;
      if (!categorias.length) { categorias = await categoriasDePlantilla(); if (fuente === 'erp') fuente = 'plantilla'; }
      const cidsDe = {}; asig.forEach(a => (cidsDe[a.product_id] = cidsDe[a.product_id] || []).push(a.cid));
      const ap = aprender(prods.map(p => ({ name: p.name, cids: cidsDe[p.id] || [] })), todas, new Set(categorias));
      const skus = new Map();
      try { (await catalogoSku(prodPool)).forEach(([s, n]) => { if (s) skus.set(String(s).trim().toLowerCase(), n || ''); }); } catch (e) {}
      bases.forEach(b => { if (b.sku && !skus.has(b.sku.toLowerCase())) skus.set(b.sku.toLowerCase(), b.name || ''); });
      const catAPedido = cats.find(c => norm(c.name) === norm(CAT_A_PEDIDO)) ? CAT_A_PEDIDO : (fuente !== 'erp' ? CAT_A_PEDIDO : '');
      let tc = null; try { const t = await web.tcMercado(); tc = { usd: Math.round(t.usd * 1.01 * 1000) / 1000, eur: Math.round(t.eur * 1.015 * 1000) / 1000, fuente: t.fuente }; } catch (e) {}
      ctxCache = { t: Date.now(), fuente, aviso, categorias, catSet: new Set(categorias), marcas: ap.marcas, tipos: ap.tipos, ejemplos: ap.ejemplos, porTipo: ap.porTipo,
        atributos: [...new Set(attrs.map(a => txt(a.name, 40)).filter(Boolean))].sort(), skus, catAPedido, tc };
      return ctxCache;
    })().finally(() => { ctxProm = null; });
    return ctxProm;
  }

  // ── IA en segundo plano (por lote) ──
  const trabajos = new Map(); // id → { total, hechos, corriendo, errores[] }
  async function correrIA(id, filasPorProducto) {
    // filasPorProducto: [{ k, filas:[filaLimpia…] }] — se renombra cada producto con sus filas
    const t = { total: filasPorProducto.reduce((a, x) => a + x.filas.length, 0), hechos: 0, corriendo: true, errores: [], inicio: Date.now() };
    trabajos.set(id, t);
    try {
      const ctx = await contexto();
      const L0 = await leerLote(id);
      const marcaLote = L0.marca || L0.opciones.marca;
      // tandas de ~30 filas sin cortar un producto por la mitad
      const tandas = []; let cur = [];
      for (const x of filasPorProducto) { if (cur.length && cur.reduce((a, y) => a + y.filas.length, 0) + x.filas.length > 30) { tandas.push(cur); cur = []; } cur.push(x); }
      if (cur.length) tandas.push(cur);
      for (const tanda of tandas) {
        const filas = tanda.flatMap(x => x.filas);
        const r = await nombrarConIA(filas, ctx, marcaLote);
        if (r.error) { t.errores.push(r.error); t.hechos += filas.length; if (t.errores.length >= 3) break; continue; } // queda lo armado sin IA
        await enCola(id, async () => {
          const L = await leerLote(id);
          const nuevos = [];
          for (const x of tanda) {
            const i = L.productos.findIndex(p => p.k === x.k); if (i < 0) continue;
            const viejo = L.productos[i];
            if (viejo.nombre_manual) continue; // lo editaste a mano mientras corría
            const nombradas = variantesSinIA(x.filas.map(f => nombrarFila(f, ctx, r.porI ? r.porI[f.i] : null)), ctx.trad);
            const grupos = agrupar(nombradas.map(f => ({ ...f, url: f.url || viejo.url })));
            // conserva lo que no es nombre (ficha, categoría manual, precios manuales)
            const reemplazo = grupos.map((g, j) => {
              const n = { ...g, k: j === 0 ? viejo.k : g.k, descripcion_html: viejo.descripcion_html || g.descripcion_html, imagenes: (viejo.imagenes || []).length ? viejo.imagenes : g.imagenes,
                peso: viejo.peso || g.peso, ficha: viejo.ficha, url: viejo.url || g.url };
              if (viejo.cat_fuente === 'manual') Object.assign(n, { categoria: viejo.categoria, cat_fuente: 'manual', cat_conf: 1, cat_nueva: viejo.cat_nueva });
              else aplicarCategoria(n, ctx);
              n.variantes.forEach(v => { const pv = viejo.variantes.find(w => w.sku && w.sku === v.sku); if (pv && pv.precio_manual) v.precio_manual = pv.precio_manual; });
              return n;
            });
            L.productos.splice(i, 1, ...reemplazo); nuevos.push(...reemplazo.map(p => p.k));
          }
          // si la IA unió filas de dos productos distintos en uno, se juntan aquí también
          fusionarIguales(L);
          revisarLote(L, ctx); await guardarLote(L);
        });
        t.hechos += filas.length;
      }
    } catch (e) { t.errores.push(e.message); }
    t.corriendo = false; t.fin = Date.now();
  }
  // Dos productos del lote con el mismo nombre base → uno solo con todas las variantes
  function fusionarIguales(L) {
    const por = new Map(), out = [];
    for (const p of L.productos) {
      const key = [p.marca, p.tipo, p.descripcion, p.info].map(norm).join('|');
      const g = por.get(key);
      const conVar = p.variantes.every(v => textoVariante(v.attrs)) && g && g.variantes.every(v => textoVariante(v.attrs));
      if (g && conVar && !p.nombre_manual) { p.variantes.forEach(v => g.variantes.push({ ...v, k: g.k + 'v' + g.variantes.length })); if (!g.url) g.url = p.url; continue; }
      if (!g) por.set(key, p);
      out.push(p);
    }
    L.productos = out;
  }

  const err = (res, e) => res.status(e.status || 500).json({ error: e.message });

  app.get('/admin/woo-creador/contexto', authAdmin, mAud, async (req, res) => {
    try {
      const c = await contexto(req.query.fresco === '1');
      res.json({ fuente: c.fuente, aviso: c.aviso, categorias: c.categorias, marcas: [...new Set(Object.values(c.marcas))].sort((a, b) => a.localeCompare(b, 'es')),
        tipos: Object.values(c.tipos).filter(t => t.n >= 2).map(t => t.tipo).sort((a, b) => a.localeCompare(b, 'es')), atributos: c.atributos, tc: c.tc, cat_a_pedido: c.catAPedido,
        ia: !!process.env.GEMINI_API_KEY, opciones: OPC_BASE, traducciones: await traduccionesTexto() });
    } catch (e) { err(res, e); }
  });

  // Elige la fila de encabezado y reconoce columnas (IA si faltan las importantes)
  app.post('/admin/woo-creador/mapear', authAdmin, mAud, async (req, res) => {
    try {
      const primeras = (Array.isArray(req.body && req.body.primeras) ? req.body.primeras : []).slice(0, 25).map(f => (Array.isArray(f) ? f : []).slice(0, 80).map(c => String(c == null ? '' : c).slice(0, 80)));
      if (!primeras.length) return res.status(400).json({ error: 'El archivo está vacío' });
      let fila = 0, mejor = -1;
      primeras.forEach((f, i) => { const n = Object.keys(reconocerColumnas(f, CAMPOS).map).length; if (n > mejor) { mejor = n; fila = i; } });
      const headers = primeras[fila];
      const muestra = primeras.slice(fila + 1).filter(f => f.filter(c => c !== '').length > 1).slice(0, 5);
      const r = reconocerColumnas(headers, CAMPOS);
      // tallas en columnas (S, M, L con cantidades) → se usan como variantes
      const faltan = ['costo', 'sku'].filter(k => r.map[k] == null).concat(r.map.nombre == null && r.map.modelo == null ? ['nombre'] : []);
      if (r.map.costo == null && r.map.pvp != null) faltan.splice(faltan.indexOf('costo'), 1);
      const hMon = [r.map.costo, r.map.pvp].filter(i => i != null).map(i => headers[i]).join(' ');
      if (/eur|€/i.test(hMon)) r.moneda = 'EUR'; else if (/usd|us\$|\$/i.test(hMon)) r.moneda = 'USD'; else if (/s\/|pen|soles/i.test(hMon)) r.moneda = 'PEN';
      let fuente = 'nombres', nota = '';
      if ((faltan.length || req.body.forzar_ia) && process.env.GEMINI_API_KEY) {
        const prompt = `Lista de precios de una marca de repuestos/accesorios de ciclismo. Columnas (índice: encabezado): ${headers.map((h, i) => `${i}: ${h}`).join(' | ')}
Filas de muestra: ${JSON.stringify(muestra)}
Asigna a cada campo el índice de columna que le corresponde (o null). Campos: ${Object.keys(CAMPOS).join(', ')}.
costo = precio de compra/dealer/neto; pvp = precio de venta al público sugerido. Responde SOLO JSON: {"map":{"campo":indice},"moneda":"USD|EUR|PEN|null","nota":"breve"}`;
        const j = leerJSON(await llamarGemini(prompt, 0, 40000));
        if (j && j.map) {
          for (const [k, v] of Object.entries(j.map)) if (CAMPOS[k] && Number.isInteger(v) && v >= 0 && v < headers.length && r.map[k] == null && !Object.values(r.map).includes(v)) { r.map[k] = v; r.conf[k] = 0.5; }
          fuente = 'nombres + IA'; nota = txt(j.nota, 200); if (/^(USD|EUR|PEN)$/.test(j.moneda || '')) r.moneda = j.moneda;
        }
      }
      res.json({ fila_encabezado: fila, headers, map: r.map, conf: r.conf, tallas_cols: r.tallas_cols, fuente, nota, moneda: r.moneda || null,
        campos: Object.keys(CAMPOS), faltan: ['sku', 'nombre'].filter(k => r.map[k] == null && !(k === 'nombre' && r.map.modelo != null)).concat(r.map.costo == null && r.map.pvp == null ? ['costo o pvp'] : []) });
    } catch (e) { err(res, e); }
  });

  // Crea el lote: arma nombres y categorías con reglas al instante; la IA los mejora en segundo plano
  app.post('/admin/woo-creador/procesar', authAdmin, mAud, async (req, res) => {
    try {
      const b = req.body || {};
      const op = opcionesLimpias(b.opciones);
      const crudas = Array.isArray(b.filas) ? b.filas.slice(0, 3000) : [];
      const filas = limpiarFilas(crudas, op);
      if (!filas.length) return res.status(400).json({ error: 'No hay filas con nombre o código' });
      const ctx = await contexto();
      if (!op.marca) { const ms = [...new Set(filas.map(f => f.marca).filter(Boolean))]; if (ms.length === 1) op.marca = ms[0]; }
      op.marca = op.marca ? marcaCanonica(op.marca, ctx) : '';
      // Respaldo sin IA (al instante)
      const nombradas = variantesSinIA(filas.map(f => nombrarFila(f, ctx, null)), ctx.trad);
      const productos = agrupar(nombradas).map(p => aplicarCategoria(p, ctx));
      const L = { nombre: txt(b.archivo || 'Lista', 200), marca: op.marca || txt((productos[0] || {}).marca, 80), opciones: op, productos, mapa: b.mapa || null };
      // recuerda qué filas originales tiene cada producto (para la IA)
      const filasDe = {}; productos.forEach(p => { filasDe[p.k] = p.variantes.map(v => filas.find(f => f.i === v.fila - 1)).filter(Boolean); });
      await prepararTablas();
      const [ins] = await portalPool.query('INSERT INTO wc_lotes (nombre, marca, datos, usuario) VALUES (?,?,?,?)', [L.nombre, txt(L.marca, 80), '{}', usuarioDe(req)]);
      L.id = ins.insertId;
      revisarLote(L, ctx); await guardarLote(L);
      const conIA = op.usar_ia && b.ia !== false && !!process.env.GEMINI_API_KEY;
      if (conIA) setImmediate(() => correrIA(L.id, productos.map(p => ({ k: p.k, filas: filasDe[p.k] }))));
      res.json({ lote: vista(L), ia: conIA ? trabajos.get(L.id) || { total: filas.length, hechos: 0, corriendo: true } : null, aviso: ctx.aviso });
    } catch (e) { err(res, e); }
  });

  app.get('/admin/woo-creador/traducciones', authAdmin, mAud, async (req, res) => {
    try { res.json({ texto: await traduccionesTexto(), base: TRAD_BASE }); } catch (e) { err(res, e); }
  });
  app.put('/admin/woo-creador/traducciones', authAdmin, mAud, async (req, res) => {
    try {
      const texto = String((req.body || {}).texto || '').slice(0, 200000);
      await prepararTablas();
      await portalPool.query("INSERT INTO wc_ajustes (clave, valor) VALUES ('traducciones', ?) ON DUPLICATE KEY UPDATE valor=VALUES(valor)", [texto]);
      tradCache = null; await traduccionesTexto();
      res.json({ ok: true, reglas: tradCache.lista.length });
    } catch (e) { err(res, e); }
  });

  app.get('/admin/woo-creador/lotes', authAdmin, mAud, async (req, res) => {
    try {
      await prepararTablas();
      const [rows] = await portalPool.query(`SELECT id, nombre, marca, usuario, creado, actualizado, LENGTH(datos) bytes FROM wc_lotes ORDER BY actualizado DESC LIMIT 60`);
      res.json({ lotes: rows.map(r => ({ ...r, ia: trabajos.get(r.id) && trabajos.get(r.id).corriendo })) });
    } catch (e) { err(res, e); }
  });
  app.get('/admin/woo-creador/lote/:id', authAdmin, mAud, async (req, res) => {
    try {
      const L = await leerLote(req.params.id); const ctx = await contexto();
      revisarLote(L, ctx);
      res.json({ lote: vista(L), ia: trabajos.get(L.id) || null });
    } catch (e) { err(res, e); }
  });
  app.delete('/admin/woo-creador/lote/:id', authAdmin, mAud, async (req, res) => {
    try { await prepararTablas(); await portalPool.query('DELETE FROM wc_lotes WHERE id=?', [num(req.params.id)]); res.json({ ok: true }); } catch (e) { err(res, e); }
  });

  // Cambios del panel: solo los campos editables de cada producto (no pisa lo que trajo el Lector en paralelo)
  const EDITABLES = ['marca', 'tipo', 'descripcion', 'info', 'categoria', 'cat_nueva', 'url', 'descripcion_html', 'imagenes', 'peso', 'sku_base'];
  app.put('/admin/woo-creador/lote/:id', authAdmin, mAud, async (req, res) => {
    const id = num(req.params.id), b = req.body || {};
    try {
      const out = await enCola(id, async () => {
        const L = await leerLote(id); const ctx = await contexto();
        if (b.opciones) L.opciones = opcionesLimpias({ ...L.opciones, ...b.opciones });
        if (b.nombre) L.nombre = txt(b.nombre, 200);
        const borrar = new Set(Array.isArray(b.borrar) ? b.borrar : []);
        if (borrar.size) L.productos = L.productos.filter(p => !borrar.has(p.k));
        for (const c of Array.isArray(b.cambios) ? b.cambios.slice(0, 3000) : []) {
          const p = L.productos.find(x => x.k === c.k); if (!p) continue;
          for (const k of EDITABLES) if (c[k] !== undefined) {
            if (k === 'imagenes') p.imagenes = (Array.isArray(c.imagenes) ? c.imagenes : String(c.imagenes).split(/[\s,]+/)).map(String).filter(u => /^https?:\/\//i.test(u)).slice(0, 20);
            else if (k === 'descripcion_html') p.descripcion_html = String(c.descripcion_html || '').slice(0, 20000);
            else if (k === 'cat_nueva') p.cat_nueva = !!c.cat_nueva;
            else if (k === 'peso') p.peso = num(c.peso) > 0 ? num(c.peso) : '';
            else p[k] = txt(c[k], k === 'categoria' ? 200 : 300);
          }
          if (['marca', 'tipo', 'descripcion', 'info'].some(k => c[k] !== undefined)) { p.nombre_manual = true; p.sin_ia = false; }
          if (c.categoria !== undefined) {
            Object.assign(p, { cat_fuente: 'manual', cat_conf: 1, cat_nota: '' });
            if (c.cat_nueva === undefined) p.cat_nueva = !!p.categoria && !ctx.catSet.has(p.categoria);
          }
          if (c.recategorizar) { p.cat_fuente = ''; aplicarCategoria(p, ctx); }
          // confirmar la categoría propuesta (deja de ser «dudosa»)
          if (c.confirmar_categoria && p.categoria) Object.assign(p, { cat_fuente: 'manual', cat_conf: 1, cat_nota: '', cat_nueva: !ctx.catSet.has(p.categoria) });
          // usar la categoría nueva sugerida
          if (c.usar_sugerida && !p.categoria && p.cat_sugerida) Object.assign(p, { categoria: p.cat_sugerida, cat_fuente: 'manual', cat_conf: 1, cat_nueva: !ctx.catSet.has(p.cat_sugerida) });
          // aplicar tus traducciones a lo ya armado (no toca los nombres que editaste a mano)
          if (c.traducir) {
            if (!p.nombre_manual) { p.descripcion = limpiarSeg(traducir(p.descripcion, ctx.trad)); p.info = limpiarSeg(traducir(p.info, ctx.trad)); }
            p.variantes.forEach(v => { for (const a of Object.keys(v.attrs || {})) v.attrs[a] = traducir(v.attrs[a], ctx.trad); });
          }
          if (c.marca_masiva) { p.marca = marcaCanonica(c.marca_masiva, ctx); p.nombre_manual = true; p.sin_ia = false; }
          if (c.tipo_masivo) { p.tipo = txt(c.tipo_masivo, 40); p.nombre_manual = true; p.sin_ia = false; if (p.cat_fuente !== 'manual') aplicarCategoria(p, ctx); }
          if (Array.isArray(c.variantes)) for (const cv of c.variantes) {
            const v = p.variantes.find(x => x.k === cv.k);
            if (!v && cv.nueva) { p.variantes.push({ k: p.k + 'v' + Date.now().toString(36), sku: txt(cv.sku, 80), ean: '', attrs: {}, costo: num(cv.costo), pvp: num(cv.pvp), moneda: L.opciones.moneda, stock: null, fila: 0, peso: '', precio_manual: null }); continue; }
            if (!v) continue;
            if (cv.borrar) { p.variantes = p.variantes.filter(x => x !== v); continue; }
            if (cv.sku !== undefined) v.sku = txt(cv.sku, 80).replace(/\s+/g, '');
            if (cv.ean !== undefined) v.ean = String(cv.ean || '').replace(/\D/g, '').slice(0, 14);
            if (cv.attrs && typeof cv.attrs === 'object') v.attrs = Object.fromEntries(Object.entries(cv.attrs).map(([a, x]) => [txt(a, 30), txt(x, 60)]).filter(([a, x]) => a && x));
            for (const k of ['costo', 'pvp']) if (cv[k] !== undefined) v[k] = Math.max(0, num(cv[k]));
            if (cv.precio_manual !== undefined) v.precio_manual = num(cv.precio_manual) > 0 ? num(cv.precio_manual) : null;
            if (['USD', 'EUR', 'PEN'].includes(cv.moneda)) v.moneda = cv.moneda;
          }
          // separar una variante como producto aparte
          if (c.separar) { const v = p.variantes.find(x => x.k === c.separar); if (v && p.variantes.length > 1) { p.variantes = p.variantes.filter(x => x !== v); const n = { ...JSON.parse(JSON.stringify(p)), k: nuevaK(), variantes: [{ ...v }] }; n.variantes[0].k = n.k + 'v0'; L.productos.splice(L.productos.indexOf(p) + 1, 0, n); } }
        }
        // reagrupar: entre los marcados, los que solo cambian en talla / medida / color escritas en el nombre
        // pasan a ser un producto con variantes (se conserva la ficha y la categoría del primero)
        if (Array.isArray(b.reagrupar) && b.reagrupar.length > 1) {
          const ps = b.reagrupar.map(k => L.productos.find(p => p.k === k)).filter(Boolean);
          const filas = ps.flatMap(p => p.variantes.map(v => ({ marca: p.marca, tipo: p.tipo, info: p.info, descripcion: p.descripcion, attrs: { ...(v.attrs || {}) }, _p: p, _v: v })));
          variantesSinIA(filas, ctx.trad);
          const grupos = new Map();
          for (const f of filas) { const k = [f.marca, f.tipo, f.descripcion, f.info].map(norm).join('|'); if (!grupos.has(k)) grupos.set(k, []); grupos.get(k).push(f); }
          for (const g of grupos.values()) {
            const prods = [...new Set(g.map(f => f._p))];
            if (prods.length < 2) continue;
            const dest = prods.find(p => (p.imagenes || []).length) || prods[0];
            dest.descripcion = g[0].descripcion; dest.nombre_manual = true; dest.sin_ia = false;
            dest.variantes = g.map((f, i) => ({ ...f._v, attrs: f.attrs, k: dest.k + 'r' + i + Date.now().toString(36) }));
            for (const p of prods) if (p !== dest) {
              if (!String(dest.descripcion_html || '').replace(/<[^>]+>/g, '').trim() && p.descripcion_html) dest.descripcion_html = p.descripcion_html;
              if (!dest.url && p.url) dest.url = p.url;
              L.productos = L.productos.filter(x => x !== p);
            }
          }
        }
        // unir productos (ej. la IA dejó dos colores como productos distintos)
        if (Array.isArray(b.unir) && b.unir.length > 1) {
          const ps = b.unir.map(k => L.productos.find(p => p.k === k)).filter(Boolean);
          const dest = ps[0]; for (const p of ps.slice(1)) { p.variantes.forEach(v => dest.variantes.push({ ...v, k: dest.k + 'v' + dest.variantes.length + Date.now().toString(36) })); L.productos = L.productos.filter(x => x !== p); }
        }
        revisarLote(L, ctx); await guardarLote(L);
        return L;
      });
      res.json({ lote: vista(out), ia: trabajos.get(id) || null });
    } catch (e) { err(res, e); }
  });

  // Rehacer nombre y categoría con IA (los marcados, o todos los que no editaste a mano)
  app.post('/admin/woo-creador/lote/:id/ia', authAdmin, mAud, async (req, res) => {
    const id = num(req.params.id);
    try {
      if (!process.env.GEMINI_API_KEY) return res.status(400).json({ error: 'Falta la clave de Gemini (GEMINI_API_KEY) en el servidor' });
      if ((trabajos.get(id) || {}).corriendo) return res.status(409).json({ error: 'La IA ya está trabajando en este lote' });
      const L = await leerLote(id); const ks = new Set(Array.isArray(req.body && req.body.ks) ? req.body.ks : []);
      const op = L.opciones;
      const sel = L.productos.filter(p => ks.size ? ks.has(p.k) : !p.nombre_manual);
      if (ks.size) await enCola(id, async () => { const L2 = await leerLote(id); L2.productos.forEach(p => { if (ks.has(p.k)) p.nombre_manual = false; }); await guardarLote(L2); });
      let n = 0;
      const lista = sel.map(p => ({ k: p.k, filas: p.variantes.map(v => ({ i: n++, marca: p.marca || op.marca, nombre: [p.tipo, p.descripcion, p.info].filter(Boolean).join(' '), modelo: '', tipo: p.cat_lista || '', sku: v.sku, ean: v.ean, attrs: v.attrs || {},
        costo: v.costo, pvp: v.pvp, moneda: v.moneda, stock: v.stock, peso: v.peso, url_imagen: '', url: p.url, desc_larga: String(p.descripcion_html || '').replace(/<[^>]+>/g, ' ').slice(0, 300), notas: '' })) }));
      setImmediate(() => correrIA(id, lista));
      res.json({ ok: true, productos: sel.length });
    } catch (e) { err(res, e); }
  });

  // Lector: ¿qué link de la web de la marca corresponde a cada producto?
  app.post('/admin/woo-creador/lote/:id/emparejar', authAdmin, mAud, async (req, res) => {
    try {
      const L = await leerLote(req.params.id); const b = req.body || {};
      let origen = ''; try { origen = new URL(String(b.origen || '')).origin; } catch (e) {}
      const links = [...new Set((Array.isArray(b.links) ? b.links : []).map(String).filter(u => { try { const x = new URL(u); return !origen || x.origin === origen; } catch (e) { return false; } }))].slice(0, 3000);
      const pares = emparejar(L.productos, links);
      // la página abierta, ¿es la ficha de un producto?
      let actual = null; const pa = emparejar(L.productos, [String(b.origen || '')]); const k1 = Object.keys(pa)[0]; if (k1) actual = k1;
      res.json({ pares, actual, links: links.length, productos: L.productos.map(p => ({ k: p.k, nombre: armarNombre(p), sku: (p.variantes[0] || {}).sku || '', url: p.url || '', ficha: !!p.ficha, fotos: (p.imagenes || []).length,
        descripcion: !!String(p.descripcion_html || '').replace(/<[^>]+>/g, '').trim() })) });
    } catch (e) { err(res, e); }
  });

  // Ficha: desde el servidor (url) o con lo que mandó el Lector (imgs + texto leídos en el navegador)
  app.post('/admin/woo-creador/lote/:id/ficha', authAdmin, mAud, async (req, res) => {
    const id = num(req.params.id), b = req.body || {}, url = String(b.url || '').slice(0, 500);
    try {
      if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Falta el link del producto en la web de la marca' });
      const L0 = await leerLote(id); const p0 = L0.productos.find(p => p.k === b.k);
      if (!p0) return res.status(404).json({ error: 'Ese producto ya no está en el lote' });
      let texto = String(b.texto || ''), imgs = Array.isArray(b.imgs) ? b.imgs : null, desc0 = '';
      if (b.html) { // el Lector nuevo manda también el HTML: descripción oficial (JSON-LD / meta) y más fotos
        const f = fichaDeHtml(String(b.html).slice(0, 3e6), url); desc0 = f.descripcion || '';
        imgs = [...(imgs || []), ...(f.imagenes || [])];
      }
      if (!texto) {
        const { html, url: final } = await leerPagina(url);
        const f = fichaDeHtml(html, final);
        texto = htmlATexto(html).slice(0, 200000); desc0 = f.descripcion || '';
        imgs = [...(f.imagenes || []), ...[...html.matchAll(/\b(?:data-src|data-lazy-src|src)=["']([^"']+\.(?:jpe?g|png|webp)[^"']*)["']/gi)].map(m => { try { return new URL(m[1], final).href; } catch (e) { return null; } }).filter(Boolean)];
      }
      if (texto.length < 200 && !(imgs || []).length) throw new Error('La página no trajo texto ni fotos' + (b.texto ? '' : '. Si la marca bloquea al portal, usa el Lector Woo Kuranko desde tu navegador.'));
      const usarIA = !!process.env.GEMINI_API_KEY && L0.opciones.usar_ia !== false;
      let r = usarIA ? await fichaDeTexto(p0, url, texto, imgs) : { ok: false, error: process.env.GEMINI_API_KEY ? 'IA apagada en este lote' : 'Sin IA (falta GEMINI_API_KEY)' };
      if (!r.ok && /no parece/.test(r.error || '')) return res.status(422).json({ error: r.error });
      // ¿la página es de este producto? (si la abriste a propósito con «forzar», se guarda igual)
      const pn = verificarPN(p0, texto, b.html || '');
      if (pn.estado === 'distinto' && !b.forzar) return res.status(422).json({ error: `El PN de la página (${pn.pn}) no coincide con el SKU ${p0.variantes.map(v => v.sku).filter(Boolean).slice(0, 2).join(' / ')}: no se guardó`, pn });
      if (!r.ok) {
        const s = fichaSinIA(p0, texto, desc0);
        const cand = [...new Set((imgs || []).map(String).filter(u => /^https?:\/\//i.test(u) && !EXCLUIR_IMG.test(u)))];
        let pool = elegirImagenes(cand, url); if (pool.length < 2) pool = cand;
        r = { ...r, html: s.html, peso: s.peso, pool: r.pool && r.pool.length ? r.pool : pool.slice(0, 40) };
      }
      const out = await enCola(id, async () => {
        const L = await leerLote(id); const ctx = await contexto();
        const p = L.productos.find(x => x.k === b.k); if (!p) throw Object.assign(new Error('Ese producto ya no está en el lote'), { status: 404 });
        p.url = url;
        if (r.html) p.descripcion_html = r.html;
        asignarFotos(p, limpiarFotos(r.pool || [], p), ctx.trad);
        if (r.peso && !p.peso) p.peso = r.peso;
        if (r.descripcion_precisa && !p.nombre_manual && norm(r.descripcion_precisa) !== norm(p.descripcion)) p.descripcion_sugerida = r.descripcion_precisa;
        p.ficha = { fecha: new Date().toISOString(), ia: !!r.ok, fuente: b.texto ? 'lector' : 'servidor', error: r.ok ? '' : r.error, pn: pn.estado, pn_pagina: pn.pn || '' };
        revisarLote(L, ctx); await guardarLote(L);
        return p;
      });
      res.json({ ok: true, producto: out, ia: r.ok, ia_error: r.ok ? null : r.error, pn });
    } catch (e) { err(res, e); }
  });

  // ── Recorrer la web y ordenar por SKU ──
  // El Lector lee páginas de la marca y las manda aquí. Se saca el PN de la página y la ficha
  // se asigna sola a los productos del lote cuyo SKU coincide (o al mismo modelo en otra talla).
  // Una página de listado (muchos códigos, ninguno marcado como PN) no se asigna: el Lector sigue sus links.
  app.post('/admin/woo-creador/lote/:id/pagina', authAdmin, mAud, async (req, res) => {
    const id = num(req.params.id), b = req.body || {}, url = String(b.url || '').slice(0, 500);
    try {
      if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Falta el link' });
      const texto = String(b.texto || ''), html = String(b.html || '').slice(0, 3e6);
      const L0 = await leerLote(id);
      // índice SKU → producto
      const porSku = new Map();
      L0.productos.forEach(p => p.variantes.forEach(v => { const k = norm(v.sku); if (k.length >= 5) porSku.set(k, p.k); }));
      const pns = pnsDePagina(texto, html).filter(x => /^(?=.*\d)(?=.*[a-z])/i.test(x));
      const coincide = new Map(); // k → estado
      for (const pn of pns) { const k = porSku.get(norm(pn)); if (k) coincide.set(k, 'ok'); }
      // varios PN del lote que no son de la misma familia → es un listado, no una ficha
      const comun0 = (a, c) => { let i = 0; while (i < a.length && a[i] === c[i]) i++; return i; };
      const pnLote = pns.map(norm).filter(x => porSku.has(x));
      if (pnLote.length > 1 && pnLote.some(x => comun0(x, pnLote[0]) < Math.max(8, Math.min(x.length, pnLote[0].length) * 0.7))) {
        return res.json({ asignados: [], pns: pns.slice(0, 3), listado: true });
      }
      // misma familia (otra talla / color de la misma página): inicio largo en común con el PN
      if (coincide.size && pns.length) {
        const pn0 = norm(pns.find(x => porSku.has(norm(x))) || pns[0]);
        const comun = (a, c) => { let i = 0; while (i < a.length && a[i] === c[i]) i++; return i; };
        for (const [sk, k] of porSku) if (!coincide.has(k) && comun(sk, pn0) >= Math.max(10, Math.min(sk.length, pn0.length) * 0.8) && sk.length === pn0.length) coincide.set(k, 'parecido');
      }
      // sin PN marcado: si en el texto aparece UN solo SKU del lote, es su página; si aparecen varios, es un listado
      let listado = false;
      if (!coincide.size) {
        const plano = norm(texto);
        const vistos = [...new Set([...porSku].filter(([sk]) => plano.includes(sk)).map(([, k]) => k))];
        if (vistos.length === 1 && !pns.length) coincide.set(vistos[0], 'en_texto');
        else if (vistos.length > 1) listado = true;
      }
      if (!coincide.size) return res.json({ asignados: [], pns: pns.slice(0, 3), listado, pendientes: L0.productos.filter(p => !(p.ficha && /ok|parecido|en_texto/.test(p.ficha.pn || ''))).length });
      // los que ya tienen ficha confirmada no se tocan (salvo «reemplazar»)
      // variantes de la página: SKU igual a un PN, o la misma familia (otra talla del mismo color)
      const pnN = pns.map(norm), comunV = (a, c) => { let i = 0; while (i < a.length && a[i] === c[i]) i++; return i; };
      // hijos de la página: el SKU es un PN de la página; y los demás hijos del mismo color (las otras tallas)
      const hijosDe = p => {
        const exactos = p.variantes.filter(v => pnN.includes(norm(v.sku)));
        if (!exactos.length) return p.variantes.filter(v => { const s = norm(v.sku); return s.length >= 5 && pnN.some(n => n.length === s.length && comunV(s, n) >= Math.max(10, s.length * 0.75)); });
        const colores = new Set(exactos.map(v => norm(colorDe(p, v))));
        if (colores.has('')) return exactos;
        return p.variantes.filter(v => exactos.includes(v) || colores.has(norm(colorDe(p, v))));
      };
      const hijoSinFoto = p => p.variantes.length > 1 && hijosDe(p).some(v => !(v.imagenes || []).length);
      const objetivo = [...coincide].filter(([k]) => { const p = L0.productos.find(x => x.k === k); return p && (b.reemplazar || hijoSinFoto(p) || !(p.ficha && /ok|parecido|en_texto/.test(p.ficha.pn || ''))); });
      if (!objetivo.length) return res.json({ asignados: [], ya: coincide.size, pns: pns.slice(0, 3) });
      const p0 = L0.productos.find(x => x.k === objetivo[0][0]);
      const usarIA = !!process.env.GEMINI_API_KEY && L0.opciones.usar_ia !== false && b.ia !== false;
      const r = await armarFicha(p0, url, texto, html, Array.isArray(b.imgs) ? b.imgs : [], usarIA);
      const out = await enCola(id, async () => {
        const L = await leerLote(id); const ctx = await contexto(); const asignados = [];
        for (const [k, estado] of objetivo) {
          const p = L.productos.find(x => x.k === k); if (!p) continue;
          const fotos = limpiarFotos(r.pool || [], p);
          const hijos = p.variantes.length > 1 ? hijosDe(p) : [];
          if (hijos.length && hijos.length < p.variantes.length) {
            // la página es de algunos hijos (un color): sus fotos van a esos hijos y se suman al padre
            for (const v of hijos) v.imagenes = fotosDelColor(fotos, colorDe(p, v), [v.sku], ctx.trad).slice(0, 8);
            p.imagenes = [...new Set([...(p.imagenes || []), ...hijos.flatMap(v => v.imagenes)])].slice(0, 16);
            if (!String(p.descripcion_html || '').replace(/<[^>]+>/g, '').trim() || b.reemplazar) p.descripcion_html = r.html || p.descripcion_html;
            if (!p.url) p.url = url;
          } else {
            p.url = url;
            if (r.html) p.descripcion_html = r.html;
            asignarFotos(p, fotos, ctx.trad);
          }
          if (r.peso && !p.peso) p.peso = r.peso;
          p.ficha = { fecha: new Date().toISOString(), ia: !!r.ok, fuente: 'recorrido', error: r.ok ? '' : r.error, pn: estado, pn_pagina: pns[0] || '' };
          asignados.push({ k, nombre: armarNombre(p, p.variantes.length === 1 ? textoVariante(p.variantes[0].attrs) : ''), estado, fotos: (p.imagenes || []).length });
        }
        revisarLote(L, ctx); await guardarLote(L);
        return { asignados, pendientes: L.productos.filter(p => !(p.ficha && /ok|parecido|en_texto/.test(p.ficha.pn || ''))).length };
      });
      res.json({ ...out, pns: pns.slice(0, 3), ia: r.ok, ia_error: r.ok ? null : r.error });
    } catch (e) { err(res, e); }
  });

  // Excel en la plantilla CREACIÓN PRODUCTOS WOOCOMMERCE
  app.post('/admin/woo-creador/lote/:id/excel', authAdmin, mAud, async (req, res) => {
    try {
      const b = req.body || {};
      const L = await leerLote(req.params.id); const ctx = await contexto();
      revisarLote(L, ctx);
      const ks = new Set(Array.isArray(b.ks) ? b.ks : []);
      let ps = L.productos.filter(p => !ks.size || ks.has(p.k));
      const excluidos = b.incluir_alertas ? [] : ps.filter(p => nivelMax(p) === 'critico');
      ps = ps.filter(p => !excluidos.includes(p));
      if (!ps.length) return res.status(400).json({ error: excluidos.length ? `Los ${excluidos.length} productos tienen alertas críticas (categoría, SKU o precio). Corrígelas o marca «Incluir con alertas».` : 'No hay productos para exportar' });
      if (!fs.existsSync(woo.PLANTILLA)) return res.status(500).json({ error: 'Falta la plantilla plantillas/creacion-productos-woocommerce.xlsx en el servidor.' });
      const filas = filasExcel(ps, L);
      const { buffer } = await woo.llenarPlantilla(fs.readFileSync(woo.PLANTILLA), filas);
      const nombre = `CREACION-PRODUCTOS-WOOCOMMERCE-${norm(L.marca || 'lista').slice(0, 20) || 'lista'}-${new Date().toISOString().slice(0, 10)}.xlsx`;
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
      res.setHeader('X-Filas', String(filas.length));
      res.setHeader('X-Productos', String(ps.length));
      res.setHeader('X-Excluidos', String(excluidos.length));
      res.setHeader('Access-Control-Expose-Headers', 'X-Filas, X-Productos, X-Excluidos, Content-Disposition');
      res.send(buffer);
    } catch (e) { err(res, e); }
  });
};

module.exports._test = { estilo, quitarSufijoMarca, verificarPN, pnsDePagina, limpiarFotos, esTecnico, colorDe, fotosDelColor, asignarFotos, fichaSinIA, TRAD_BASE, leerTraducciones, traducir, variantesEnNombre, variantesSinIA, CAMPOS, rutasCategorias, segmentos, aprender, elegirCategoria, porPalabras, armarNombre, textoVariante, nombreSinIA, nombrarFila, limpiarFilas, agrupar,
  revisar, precioVenta, opcionesLimpias, redondear, filasExcel, skuPadre, emparejar, htmlDescripcion, aplicarCategoria, nivelMax };
