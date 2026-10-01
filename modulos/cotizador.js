// ═══════════════════════════════════════════════════════════════════════════
//  MÓDULO: Cotizador rápido (vendedores)
//  Busca un producto o variante por nombre o SKU (tolera errores de tipeo,
//  palabras en otro orden, tildes, guiones) y devuelve:
//    - stock disponible (por almacén) y empresa dueña del producto
//    - precio normal de venta del sistema
//    - PRECIO MÍNIMO = costo FIFO de las unidades más antiguas / FACTOR_MINIMO
//      (por defecto 1 unidad; si el vendedor indica N unidades se promedia el
//       costo de las N más antiguas).
//  El costo real SOLO se envía al admin maestro. El vendedor ve precio mínimo.
//  Solo lectura sobre producción.
// ═══════════════════════════════════════════════════════════════════════════

const { EMPRESAS_BI } = require('./comunes');

// precio mínimo = costo / 0.9  → el costo representa el 90% del precio (margen 10% sobre precio)
const FACTOR_MINIMO = 0.9;

// ── Precio SUGERIDO (venta a ciclista final, B2C) ────────────────────────────
// Sigue la práctica del sector ciclismo:
//  · Bicicletas: manda el AÑO MODELO (en el nombre, ej. "... 2025"), no los días en almacén.
//  · Componentes, ropa/cascos y consumibles: se rebajan por antigüedad, cada uno a su ritmo.
// Los % son de descuento sobre el precio normal; 'min' = precio mínimo. Nunca baja del mínimo.
// Se pueden cambiar sin tocar código con la variable de Railway COTIZADOR_REGLAS (JSON con la
// misma forma que REGLAS_BASE; solo hace falta poner lo que cambia).
const REGLAS_BASE = {
  // años de diferencia con el año vigente → % ; el año anterior tiene % de ene–jun y de jul–dic
  bicicleta: { vigente: 0, anterior: [10, 20], dos_anios: 30, mas: 'min' },
  // bicis sin año modelo en el nombre, componentes, ropa y consumibles: [hasta N meses, %] y 'despues'
  bicicleta_sin_anio: { tramos: [[12, 0], [24, 15], [36, 30]], despues: 'min' },
  componente: { tramos: [[18, 0], [30, 10], [48, 20]], despues: 'min' },
  ropa: { tramos: [[12, 0], [18, 15], [24, 30]], despues: 'min' },
  consumible: { tramos: [[12, 0], [24, 10]], despues: 25 }
};
let REGLAS = REGLAS_BASE;
try {
  if (process.env.COTIZADOR_REGLAS) REGLAS = { ...REGLAS_BASE, ...JSON.parse(process.env.COTIZADOR_REGLAS) };
} catch (e) { console.warn('[cotizador] COTIZADOR_REGLAS no es JSON válido, se usan las reglas base:', e.message); }

const NOMBRE_TIPO = { bicicleta: 'Bicicleta', componente: 'Componente / accesorio', ropa: 'Ropa, cascos y calzado', consumible: 'Consumible' };

// Clasifica el producto por sus categorías del ERP (y el nombre, si no tiene categoría).
function tipoProducto(categorias, nombre) {
  const cats = normalizar(categorias);
  const nom = normalizar(nombre);
  const esRepuesto = /repuesto|componente|accesorio|parte|pieza|herramienta/.test(cats);
  if (!esRepuesto && (/(^| )(bicicletas?|bicis?|e ?bikes?|bikes?)( |$)/.test(cats) || /^(bicicleta|bici|e ?bike)( |$)/.test(nom)))
    return 'bicicleta';
  const txt = cats + ' ' + nom;
  if (/(^| )(ropa|indumentaria|vestimenta|jersey|jerseys|polo|polos|short|shorts|culotte?s?|casaca|casacas|chaleco|guantes?|cascos?|zapatillas?|calzado|lentes|gafas|medias|calcetines|bibs?)( |$)/.test(txt))
    return 'ropa';
  if (/(^| )(llantas?|neumaticos?|cubiertas?|camaras?|tubeless|sellante|lubricantes?|grasa|aceite|pastillas?|zapatas?|cinta|limpiador|limpieza|cadenas?|cables?|fundas?)( |$)/.test(txt))
    return 'consumible';
  return 'componente';
}

// Año modelo en el nombre: "2025", "MY25", "MY 2025". Devuelve null si no hay.
function anioModelo(nombre) {
  const t = normalizar(nombre), tope = new Date().getFullYear() + 1;
  let anio = null;
  (t.match(/(^| )(20[12]\d)( |$)/g) || []).forEach(m => { const y = +m.trim(); if (y <= tope && (!anio || y > anio)) anio = y; });
  const my = t.match(/(^| )my ?(20)?(\d{2})( |$)/);
  if (!anio && my) anio = 2000 + Number(my[3]);
  return anio;
}

const pctTramos = (regla, meses) => {
  for (const [hasta, pct] of regla.tramos) if (meses < hasta) return pct;
  return regla.despues;
};
const textoMeses = m => m < 12 ? `${Math.floor(m)} meses` : `${(m / 12).toFixed(1).replace('.0', '')} años`;

// Devuelve { pct (número o 'min'), motivo }
function reglaSugerido(tipo, anio, edadDias) {
  const meses = (edadDias || 0) / 30.44;
  if (tipo === 'bicicleta' && anio) {
    const hoy = new Date(), dif = hoy.getFullYear() - anio, r = REGLAS.bicicleta;
    if (dif <= 0) return { pct: r.vigente, motivo: `año modelo ${anio} (vigente)` };
    if (dif === 1) {
      const pct = Array.isArray(r.anterior) ? r.anterior[hoy.getMonth() < 6 ? 0 : 1] : r.anterior;
      return { pct, motivo: `año modelo ${anio} (año anterior)` };
    }
    if (dif === 2) return { pct: r.dos_anios, motivo: `año modelo ${anio} (hace 2 años)` };
    return { pct: r.mas, motivo: `año modelo ${anio} (hace ${dif} años)` };
  }
  const regla = tipo === 'bicicleta' ? REGLAS.bicicleta_sin_anio : (REGLAS[tipo] || REGLAS.componente);
  return { pct: pctTramos(regla, meses), motivo: `stock de ${textoMeses(meses)}${tipo === 'bicicleta' ? ' (sin año modelo en el nombre)' : ''}` };
}

// PVP recomendado = costo de la ÚLTIMA compra ÷ 0.45 (sirve cuando el producto no tiene precio
// en el sistema o el que tiene está mal). Configurable con COTIZADOR_FACTOR_PVP.
const FACTOR_PVP = Number(process.env.COTIZADOR_FACTOR_PVP) || 0.45;
const IGV = 1.18;
// Comparaciones: dentro de ±5% se considera "similar"
const MARGEN_SIMILAR = 5;
const VV_COT = "('paid','confirmed','pending_payment')";

// Precio de mercado en internet (indicador automático, con IA + búsqueda de Google).
// Tiendas que NUNCA se muestran (nombre o dominio), separadas por coma: COTIZADOR_TIENDAS_OCULTAS.
const TIENDAS_OCULTAS = (process.env.COTIZADOR_TIENDAS_OCULTAS || 'lordgun')
  .split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
const MODELO_IA = (process.env.COTIZADOR_MODELO_IA || 'gemini-3.6-flash').replace(/[^a-zA-Z0-9.\-]/g, '');
const INTERNET_TTL = 7 * 24 * 60 * 60 * 1000;   // cada producto se vuelve a buscar como máximo 1 vez por semana
const INTERNET_TTL_FALLA = 6 * 60 * 60 * 1000;  // si no encontró nada, reintenta en 6 h

function comparar(precio, ref) {
  if (!(precio > 0) || !(ref > 0)) return null;
  const dif = Math.round((precio / ref - 1) * 1000) / 10;
  return { ref: Math.round(ref * 100) / 100, dif_pct: dif,
    nivel: dif > MARGEN_SIMILAR ? 'alto' : dif < -MARGEN_SIMILAR ? 'bajo' : 'similar' };
}
const esOculta = (...txt) => TIENDAS_OCULTAS.some(o => txt.some(t => String(t || '').toLowerCase().includes(o)));

// Tipo de cambio a soles (open.er-api.com, caché 3 h). Respaldo: PRECIO_IMP_TC_USD / PRECIO_IMP_TC_EUR.
const TC_TTL = 3 * 60 * 60 * 1000;
let _tc = null;
async function tasasPEN() {
  if (_tc && Date.now() - _tc.t < TC_TTL) return _tc;
  try {
    const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch('https://open.er-api.com/v6/latest/USD', { signal: ctrl.signal });
    clearTimeout(to);
    const d = await r.json();
    const pen = d && d.rates && +d.rates.PEN;
    if (!(pen > 0)) throw new Error('sin PEN');
    const porMoneda = {};
    Object.entries(d.rates).forEach(([m, v]) => { if (+v > 0) porMoneda[m] = pen / +v; });
    _tc = { porMoneda, t: Date.now() };
  } catch (e) {
    console.warn('[cotizador] tipo de cambio:', e.message);
    if (!_tc) _tc = { porMoneda: { PEN: 1, USD: +process.env.PRECIO_IMP_TC_USD || 3.44, EUR: +process.env.PRECIO_IMP_TC_EUR || 3.90 },
      t: Date.now() - TC_TTL + 10 * 60 * 1000 };
  }
  return _tc;
}

// Extrae el JSON de la respuesta de la IA (puede venir con ```json ... ```)
function jsonDeTexto(t) {
  const s = String(t || '').replace(/```json|```/g, '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
}

const CAT_TTL = 5 * 60 * 1000; // el catálogo con stock se refresca cada 5 min

// Ubicaciones propias que no son almacén/tienda de venta directa: se agrupan como "Otros"
// (se muestran y suman en su propio grupo, pero no cuentan como "se entrega ya").
// Se comparan por nombre, sin tildes ni mayúsculas. Se puede cambiar sin tocar código con la
// variable de Railway COTIZADOR_OTROS (nombres separados por coma).
const OTROS = (process.env.COTIZADOR_OTROS || process.env.COTIZADOR_NO_VENDIBLES || 'CUARENTENA,EN EXHIBICION,EMBAJADOR')
  .split(',').map(x => x.trim()).filter(Boolean);

// ── Normalización y búsqueda difusa ─────────────────────────────────────────
// "Bicícleta  Crafty-Carbon RR" → "bicicleta crafty carbon rr"
function normalizar(t) {
  return String(t || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}
// separa "29er" / "m29" en letras y números extra para que "29" encuentre "29er"
function tokens(t) {
  const base = normalizar(t).split(' ').filter(Boolean);
  const extra = [];
  base.forEach(w => {
    const partes = w.match(/[a-z]+|[0-9]+/g) || [];
    if (partes.length > 1) partes.forEach(p => { if (p.length > 1) extra.push(p); });
  });
  // tallas escritas "M/L", "S-M" → también "ml", "sm"
  for (let i = 0; i + 1 < base.length; i++)
    if (base[i].length === 1 && base[i + 1].length === 1 && /[a-z]/.test(base[i] + base[i + 1])) extra.push(base[i] + base[i + 1]);
  return [...new Set(base.concat(extra))];
}

// Sinónimos frecuentes al cotizar (español ↔ inglés del catálogo)
const SINONIMOS = [
  ['azul', 'blue'], ['negro', 'black'], ['rojo', 'red'], ['blanco', 'white'], ['verde', 'green'],
  ['gris', 'grey', 'gray'], ['amarillo', 'yellow'], ['naranja', 'orange'], ['morado', 'purple'],
  ['plateado', 'silver'], ['dorado', 'gold'], ['rosado', 'pink'],
  ['llanta', 'neumatico', 'tire', 'tyre', 'cubierta'], ['camara', 'tube', 'neumatico'],
  ['casete', 'cassette', 'pinon', 'pinones'], ['cadena', 'chain'], ['casco', 'helmet'],
  ['horquilla', 'suspension', 'fork'], ['aro', 'rin', 'rim'], ['rueda', 'wheel', 'wheelset'],
  ['freno', 'brake'], ['pedal', 'pedales'], ['asiento', 'sillin', 'saddle'], ['guantes', 'gloves'],
  ['luz', 'light', 'luces'], ['bici', 'bicicleta', 'bike']
];
const SIN_MAP = {};
SINONIMOS.forEach(g => g.forEach(w => { SIN_MAP[w] = g; }));
const compacto = t => normalizar(t).replace(/ /g, '');

// Distancia Damerau-Levenshtein (transposición incluida: "carbno" ≈ "carbon")
function distancia(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const n = a.length, m = b.length;
  let prev2 = null, prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const cur = [i];
    let minFila = i;
    for (let j = 1; j <= m; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + c);
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v; if (v < minFila) minFila = v;
    }
    if (minFila > max) return max + 1;
    prev2 = prev; prev = cur;
  }
  return prev[m];
}
// errores permitidos según largo de la palabra buscada
const tolerancia = len => len <= 3 ? 0 : len <= 5 ? 1 : 2;

// Qué tan bien una palabra buscada calza con las palabras del producto (0..1)
function puntajePalabra(q, palabras, compactoItem) {
  const alternativas = SIN_MAP[q];
  if (alternativas) {
    // un sinónimo exacto vale casi como la palabra original
    for (const alt of alternativas) if (alt !== q && palabras.includes(alt)) return 0.95;
  }
  let mejor = 0;
  for (const w of palabras) {
    if (w === q) return 1;
    if (w.startsWith(q)) mejor = Math.max(mejor, q.length >= 2 ? 0.9 : 0.5);
    else if (q.length >= 3 && w.includes(q)) mejor = Math.max(mejor, 0.75);
    else {
      const tol = tolerancia(q.length);
      if (tol) {
        // compara también contra el prefijo (para palabras a medio escribir con error)
        const d = Math.min(distancia(q, w, tol), w.length > q.length ? distancia(q, w.slice(0, q.length), tol) : tol + 1);
        if (d <= tol) mejor = Math.max(mejor, 0.85 - d * 0.15);
      }
    }
  }
  // palabras pegadas: "carbonrr" dentro de "craftycarbonrr2026"
  if (mejor < 0.7 && q.length >= 4 && compactoItem.includes(q)) mejor = 0.7;
  return mejor;
}

function puntuar(consulta, item) {
  const qComp = compacto(consulta);
  if (!qComp) return 0;
  // 1) SKU: exacto o contenido (ignorando guiones/espacios)
  if (item._sku && item._sku === qComp) return 100;
  let sku = 0;
  if (item._sku && qComp.length >= 3 && item._sku.includes(qComp)) sku = 80;
  else if (item._sku && qComp.length >= 5 && distancia(qComp, item._sku, 1) <= 1) sku = 70;
  // 2) Nombre: cada palabra buscada se compara contra todas las del producto (orden libre)
  const qs = tokens(consulta).filter(t => !(t.length === 1 && /[a-z]/.test(t)));
  if (!qs.length) return sku;
  let suma = 0, fallas = 0;
  for (const q of qs) {
    const p = puntajePalabra(q, item._pal, item._comp);
    if (p < 0.5) fallas++;
    suma += p;
  }
  // se tolera 1 palabra que no calce si se escribieron 3 o más
  if (fallas > (qs.length >= 3 ? 1 : 0)) return sku;
  // la palabra que no calzó resta, pero no anula el resultado
  const nombre = (suma / (qs.length - fallas * 0.5)) * 60 - fallas * 8;
  return Math.max(sku, nombre);
}

module.exports = function registrarCotizador({ app, authAdmin, requiereModulo, prodPool }) {
  const mCot = requiereModulo('cotizador');

  // ── Catálogo en caché: variantes vendibles + stock por almacén + empresa ──
  let _cat = null, _catAt = 0, _cargando = null;
  async function catalogo(forzar) {
    if (!forzar && _cat && Date.now() - _catAt < CAT_TTL) return _cat;
    if (_cargando) return _cargando;
    _cargando = (async () => {
      const [prods] = await prodPool.query(`
        SELECT pv.id AS vid, TRIM(pv.sku) AS sku, pv.name AS variacion,
          pv.regular_price, pv.sale_price, pv.product_id AS pid, p.name AS producto
        FROM product_variations pv
        LEFT JOIN products p ON p.id = pv.product_id
        WHERE pv.deleted_at IS NULL AND (p.id IS NULL OR p.deleted_at IS NULL)
          AND COALESCE(pv.product_type,'') <> 'variable'
          AND (pv.status IS NULL OR pv.status = 'active')`);

      const [stock] = await prodPool.query(`
        SELECT ls.product_variation_id AS vid, l.id AS loc_id, l.name AS almacen, l.type AS tipo,
          ls.quantity AS cantidad, ls.reserved_quantity AS reservado
        FROM location_stocks ls JOIN locations l ON l.id = ls.location_id
        WHERE ls.quantity > 0`);
      const otrosSet = new Set(OTROS.map(normalizar));
      const stMap = {};
      stock.forEach(s => {
        const e = stMap[s.vid] = stMap[s.vid] || { disponible: 0, consignacion: 0, otros: 0, almacenes: [] };
        const cant = Number(s.cantidad || 0), res = Number(s.reservado || 0);
        const disp = Math.max(0, cant - res);
        // grupo: 'consignacion' por tipo del ERP; 'otros' por nombre (cuarentena, exhibición…); resto 'propio'
        const grupo = s.tipo === 'consignment' ? 'consignacion'
          : otrosSet.has(normalizar(s.almacen)) ? 'otros' : 'propio';
        if (grupo === 'consignacion') e.consignacion += disp;
        else if (grupo === 'otros') e.otros += disp;
        else e.disponible += disp;
        e.almacenes.push({ almacen: s.almacen || ('Almacén ' + s.loc_id), cantidad: cant, reservado: res,
          disponible: disp, grupo, consignacion: grupo === 'consignacion' });
      });

      // Empresa dueña y antigüedad: según lotes con existencia (stock_batches)
      const [emp] = await prodPool.query(`
        SELECT product_variation_id AS vid, company_id, SUM(quantity) AS unidades,
          MIN(entry_date) AS mas_antiguo, MAX(entry_date) AS mas_nuevo
        FROM stock_batches WHERE quantity > 0 GROUP BY product_variation_id, company_id`);
      const empMap = {}, antMap = {};
      const f10 = d => d ? (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10) : null;
      emp.forEach(r => {
        (empMap[r.vid] = empMap[r.vid] || []).push({
          empresa: EMPRESAS_BI[r.company_id] || (r.company_id ? `Empresa ${r.company_id}` : 'Sin empresa'),
          unidades: Number(r.unidades)
        });
        const a = antMap[r.vid] = antMap[r.vid] || { antiguo: null, nuevo: null };
        const ant = f10(r.mas_antiguo), nue = f10(r.mas_nuevo);
        if (ant && (!a.antiguo || ant < a.antiguo)) a.antiguo = ant;
        if (nue && (!a.nuevo || nue > a.nuevo)) a.nuevo = nue;
      });

      // Categorías por producto (para clasificar bicicleta / componente / ropa / consumible)
      const catMap = {};
      try {
        const [cats] = await prodPool.query(`
          SELECT ppc.product_id AS pid, c.name AS cat, padre.name AS padre
          FROM product_product_category ppc
          JOIN product_categories c ON c.id = ppc.product_category_id
          LEFT JOIN product_categories padre ON padre.id = c.parent_id`);
        cats.forEach(r => { (catMap[r.pid] = catMap[r.pid] || []).push([r.padre, r.cat].filter(Boolean).join(' ')); });
      } catch (e) { console.warn('[cotizador] no se pudieron leer categorías:', e.message); }

      // Imagen de referencia: la de la variación si tiene; si no, la del producto padre
      // (product_images.path es la URL completa; primaria primero, luego sort_order).
      const imgVar = {}, imgProd = {};
      try {
        const [imgs] = await prodPool.query(`
          SELECT product_id, product_variation_id, path FROM product_images
          WHERE deleted_at IS NULL AND path IS NOT NULL AND path <> ''
          ORDER BY is_primary DESC, sort_order ASC, id ASC`);
        imgs.forEach(im => {
          if (im.product_variation_id != null) { if (!imgVar[im.product_variation_id]) imgVar[im.product_variation_id] = im.path; }
          else if (im.product_id != null && !imgProd[im.product_id]) imgProd[im.product_id] = im.path;
        });
      } catch (e) { console.warn('[cotizador] no se pudieron leer imágenes:', e.message); }

      // Última compra por variación (lote más reciente con costo), para el PVP recomendado
      const ultCosto = {};
      try {
        const [uc] = await prodPool.query(`
          SELECT product_variation_id AS vid, cost_price, entry_date FROM stock_batches
          WHERE cost_price > 0 ORDER BY product_variation_id, entry_date DESC, id DESC`);
        uc.forEach(r => { if (!ultCosto[r.vid]) ultCosto[r.vid] = { costo: Number(r.cost_price), fecha: r.entry_date }; });
      } catch (e) { console.warn('[cotizador] no se pudo leer la última compra:', e.message); }

      _cat = prods.map(p => {
        // Se muestra solo el nombre del hijo (variación/simple), que en el ERP ya es el nombre completo.
        // El del padre se usa solo si el hijo no tiene nombre. Para buscar se usan los dos.
        const nombre = (p.variacion || '').trim() || (p.producto || '').trim() || '—';
        const st = stMap[p.vid] || { disponible: 0, consignacion: 0, otros: 0, almacenes: [] };
        st.almacenes.sort((a, b) => b.disponible - a.disponible || b.cantidad - a.cantidad);
        const oferta = p.sale_price != null && Number(p.sale_price) > 0 ? Number(p.sale_price) : null;
        const categorias = (catMap[p.pid] || []).join(' | ');
        const uc = ultCosto[p.vid];
        const pvpRec = uc && uc.costo > 0 ? Math.ceil(uc.costo / FACTOR_PVP) : null;
        const normalSis = oferta != null ? oferta : Number(p.regular_price || 0);
        const tipo = tipoProducto(categorias, p.producto || nombre);
        return {
          imagen: imgVar[p.vid] || imgProd[p.pid] || null,
          // PVP recomendado (costo última compra ÷ 0.45). Si el producto no tiene precio en el
          // sistema, se usa como precio base para cotizar.
          pvp_recomendado: pvpRec, sin_precio: !(normalSis > 0),
          precio_base: normalSis > 0 ? normalSis : pvpRec,
          _costo_ultimo: uc ? uc.costo : null, _fecha_ultima_compra: uc ? uc.fecha : null,
          // alias para compatibilidad con Precio importado (otra conversación usaba estos nombres)
          _costo: uc ? uc.costo : null, base_es_recomendado: !(normalSis > 0) && !!pvpRec,
          categoria: categorias || null, tipo, tipo_nombre: NOMBRE_TIPO[tipo],
          anio_modelo: tipo === 'bicicleta' ? anioModelo(nombre + ' ' + (p.producto || '')) : null,
          vid: p.vid, pid: p.pid, sku: p.sku || '', nombre,
          precio_regular: Number(p.regular_price || 0),
          precio_oferta: oferta,
          precio_normal: oferta != null ? oferta : Number(p.regular_price || 0),
          // stock = en almacenes/tiendas propias (se entrega ya); consignación = en tiendas de clientes;
          // otros = cuarentena, exhibición, embajador… stock_total cuadra con el ERP.
          stock: st.disponible, stock_consignacion: st.consignacion, stock_otros: st.otros,
          stock_total: st.disponible + st.consignacion + st.otros,
          almacenes: st.almacenes,
          empresas: (empMap[p.vid] || []).sort((a, b) => b.unidades - a.unidades),
          // antigüedad del stock: fecha de ingreso del lote más antiguo y del más reciente con existencia
          lote_mas_antiguo: (antMap[p.vid] || {}).antiguo || null,
          lote_mas_nuevo: (antMap[p.vid] || {}).nuevo || null,
          _sku: compacto(p.sku), _pal: tokens(nombre + ' ' + (p.producto || '')), _comp: compacto(nombre)
        };
      });
      _catAt = Date.now();
      return _cat;
    })();
    try { return await _cargando; } finally { _cargando = null; }
  }
  const publico = ({ _sku, _pal, _comp, _costo_ultimo, _fecha_ultima_compra, _costo, ...x }) => x;

  // ── Costo FIFO de las N unidades más antiguas ─────────────────────────────
  async function precioMinimo(vid, cantidad) {
    const [lotes] = await prodPool.query(`
      SELECT id, quantity, cost_price, entry_date, company_id
      FROM stock_batches WHERE product_variation_id = ? AND quantity > 0
      ORDER BY entry_date ASC, id ASC`, [vid]);
    let faltan = cantidad, costoTotal = 0, tomadas = 0, sinCosto = false, diasTotal = 0;
    const hoy = Date.now();
    const usados = [];
    for (const l of lotes) {
      if (faltan <= 0) break;
      const q = Math.min(Number(l.quantity), faltan);
      const c = Number(l.cost_price || 0);
      if (!(c > 0)) sinCosto = true;
      costoTotal += q * c; tomadas += q; faltan -= q;
      if (l.entry_date) diasTotal += q * Math.max(0, Math.floor((hoy - new Date(l.entry_date).getTime()) / 864e5));
      usados.push({ lote: l.id, fecha: l.entry_date, unidades: q, costo: c,
        empresa: EMPRESAS_BI[l.company_id] || (l.company_id ? `Empresa ${l.company_id}` : '—') });
    }
    const costoProm = tomadas > 0 ? costoTotal / tomadas : 0;
    // se redondea HACIA ARRIBA al sol entero, para que nunca quede por debajo del mínimo
    const minimo = costoProm > 0 && !sinCosto ? Math.ceil(costoProm / FACTOR_MINIMO) : null;
    return { cantidad_pedida: cantidad, unidades_con_costo: tomadas, insuficiente: tomadas < cantidad,
      sin_costo: sinCosto || tomadas === 0, costo_prom: costoProm, precio_minimo: minimo,
      edad_dias: tomadas > 0 ? Math.round(diasTotal / tomadas) : null,
      lote_mas_antiguo: lotes.length ? lotes[0].entry_date : null, lotes: usados };
  }

  // GET /api/cotizador/buscar?q=crafty carbon m
  app.get('/api/cotizador/buscar', authAdmin, mCot, async (req, res) => {
    try {
      const q = String(req.query.q || '').trim().slice(0, 80);
      if (q.length < 2) return res.json({ items: [] });
      const soloStock = req.query.solo_stock === '1';
      const cat = await catalogo(req.query.fresh === '1');
      const res_ = [];
      for (const it of cat) {
        if (soloStock && it.stock_total <= 0) continue;
        const s = puntuar(q, it);
        if (s >= 30) res_.push([s + (it.stock > 0 ? 3 : it.stock_total > 0 ? 1 : 0), it]);
      }
      res_.sort((a, b) => b[0] - a[0] || b[1].stock_total - a[1].stock_total);
      res.json({ items: res_.slice(0, 30).map(([s, it]) => ({ ...publico(it), puntaje: Math.round(s) })),
        total: res_.length, actualizado: new Date(_catAt).toISOString() });
    } catch (e) { console.error('[cotizador] buscar', e.message); res.status(500).json({ error: 'No se pudo buscar: ' + e.message }); }
  });

  // GET /api/cotizador/precio?vid=123&cantidad=3
  app.get('/api/cotizador/precio', authAdmin, mCot, async (req, res) => {
    try {
      const vid = parseInt(req.query.vid, 10);
      const cantidad = Math.max(1, Math.min(999, parseInt(req.query.cantidad, 10) || 1));
      if (!vid) return res.status(400).json({ error: 'Falta el producto' });
      const cat = await catalogo();
      const it = cat.find(x => x.vid === vid);
      const r = await precioMinimo(vid, cantidad);
      // Precio base para cotizar: el normal del sistema; si no tiene (0), el PVP recomendado
      const normal = it ? it.precio_normal : null;
      const base = it ? it.precio_base : null;
      // Precio sugerido (B2C) según tipo de producto y año modelo / antigüedad de las unidades a vender
      let sug = null;
      if (base > 0 && it) {
        const rg = reglaSugerido(it.tipo, it.anio_modelo, r.edad_dias);
        let precio = base, nota = null;
        if (r.precio_minimo == null) nota = 'sin costo registrado: se mantiene el precio ' + (it.sin_precio ? 'recomendado' : 'normal');
        else if (r.precio_minimo >= base) nota = 'el mínimo supera al precio ' + (it.sin_precio ? 'recomendado' : 'normal');
        else if (rg.pct === 'min') precio = r.precio_minimo;
        else precio = Math.max(r.precio_minimo, Math.round(base * (1 - Number(rg.pct || 0) / 100)));
        sug = { precio, tipo: it.tipo, tipo_nombre: it.tipo_nombre, regla_pct: rg.pct, motivo: rg.motivo, nota,
          base: it.sin_precio ? 'pvp_recomendado' : 'precio_normal',
          topado_en_minimo: r.precio_minimo != null && precio === r.precio_minimo && rg.pct !== 'min',
          descuento_pct: Math.round((1 - precio / base) * 1000) / 10 };
      }

      // Ventas registradas de este producto (últimos 24 meses): precio promedio y última venta
      let vendido = null;
      try {
        const [[v]] = await prodPool.query(`
          SELECT COUNT(DISTINCT s.id) AS ventas, SUM(si.quantity) AS unidades,
            SUM(si.total) / SUM(si.quantity) AS precio_prom, MAX(s.created_at) AS ultima
          FROM sale_items si JOIN sales s ON s.id = si.sale_id
          WHERE si.product_variation_id = ? AND s.deleted_at IS NULL AND s.status IN ${VV_COT}
            AND s.created_at >= DATE_SUB(NOW(), INTERVAL 24 MONTH) AND si.quantity > 0 AND si.total > 0`, [vid]);
        if (v && Number(v.unidades) > 0) {
          const [[u]] = await prodPool.query(`
            SELECT si.total / si.quantity AS precio, s.created_at AS fecha
            FROM sale_items si JOIN sales s ON s.id = si.sale_id
            WHERE si.product_variation_id = ? AND s.deleted_at IS NULL AND s.status IN ${VV_COT}
              AND si.quantity > 0 AND si.total > 0
            ORDER BY s.created_at DESC LIMIT 1`, [vid]);
          vendido = { ventas: Number(v.ventas), unidades: Number(v.unidades),
            precio_prom: Math.round(Number(v.precio_prom) * 100) / 100, ultima: v.ultima,
            ultimo_precio: u ? Math.round(Number(u.precio) * 100) / 100 : null };
        }
      } catch (e) { console.warn('[cotizador] ventas registradas:', e.message); }

      // ¿El precio del sistema está alto o bajo? vs PVP recomendado y vs lo que se ha vendido
      const comparacion = {
        vs_pvp_recomendado: normal > 0 ? comparar(normal, it.pvp_recomendado) : null,
        vs_vendido: normal > 0 && vendido ? comparar(normal, vendido.precio_prom) : null
      };

      const out = {
        vid, cantidad, factor: FACTOR_MINIMO,
        precio_normal: normal,
        sin_precio: it ? it.sin_precio : null,
        pvp_recomendado: it ? it.pvp_recomendado : null, factor_pvp: FACTOR_PVP,
        precio_base: base,
        precio_minimo: r.precio_minimo,
        precio_sugerido: sug ? sug.precio : null, sugerido: sug, edad_dias: r.edad_dias,
        vendido, comparacion,
        insuficiente: r.insuficiente, unidades_con_costo: r.unidades_con_costo,
        sin_costo: r.sin_costo, lote_mas_antiguo: r.lote_mas_antiguo,
        descuento_max_pct: base > 0 && r.precio_minimo
          ? Math.round((1 - r.precio_minimo / base) * 1000) / 10 : null
      };
      // El costo real y el detalle de lotes solo para el admin maestro
      if (req.admin && req.admin.maestro) {
        out.costo_prom = Math.round(r.costo_prom * 100) / 100;
        out.lotes = r.lotes;
        if (it) { out.costo_ultima_compra = it._costo_ultimo; out.fecha_ultima_compra = it._fecha_ultima_compra; }
      }
      res.json(out);
    } catch (e) { console.error('[cotizador] precio', e.message); res.status(500).json({ error: 'No se pudo calcular: ' + e.message }); }
  });

  // ── Precio de mercado en internet (indicador automático) ───────────────────
  // La IA (Gemini, con búsqueda de Google) busca el mismo producto en tiendas online y
  // devuelve precio, moneda y link. Se convierte a soles y, si la tienda no es peruana,
  // se multiplica × 1.18 (IGV) para compararlo con nuestro precio. Las tiendas de
  // TIENDAS_OCULTAS nunca se muestran. Resultado en memoria por producto (1 semana).
  const _inet = new Map(), _inetEnCurso = new Map();
  async function buscarInternet(it) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) return { disponible: false, motivo: 'Falta GEMINI_API_KEY en el servidor' };
    const prompt = `Eres un comprador de una tienda de bicicletas en Perú. Busca en internet el precio de venta ACTUAL de este producto exacto:
"${it.nombre}"${it.sku ? ` (código/SKU del distribuidor: ${it.sku})` : ''}.
Busca en tiendas online de ciclismo de Perú y del extranjero (por ejemplo Bike24, Bike-components, Bike-Discount, R2-Bike, Bikeinn/Tradeinn, Chain Reaction, Amazon, Mercado Libre Perú y tiendas peruanas).
NO incluyas resultados de: ${TIENDAS_OCULTAS.join(', ')}.
Reglas: solo el MISMO producto y la misma versión (modelo, año, tamaño o capacidad si aplica; el color puede variar). Usa el precio con descuento vigente, sin envío. Si no estás seguro de que sea el mismo producto, no lo incluyas. Máximo 5 tiendas.
Responde SOLO con JSON, sin texto adicional:
{"resultados":[{"tienda":"nombre","url":"https://...","pais":"código ISO de 2 letras","moneda":"código ISO de 3 letras","precio":123.45}]}
Si no encuentras nada, responde {"resultados":[]}.`;
    // Se intenta con el modelo configurado y, si Google responde error, con un modelo de respaldo.
    const modelos = [...new Set([MODELO_IA, 'gemini-2.5-flash'])];
    let txt = '', ultimoError = null;
    // Cada modelo se prueba hasta 2 veces si Google responde "saturado" (429/503/overloaded),
    // esperando 3 s entre intentos; luego pasa al modelo de respaldo.
    const intentos = [];
    modelos.forEach(m => { intentos.push(m, m); });
    let saturadoPrevio = null;
    for (let i = 0; i < intentos.length; i++) {
      const mdl = intentos[i];
      // el 2.º intento del mismo modelo solo si el 1.º fue por saturación
      if (i > 0 && intentos[i - 1] === mdl && saturadoPrevio !== mdl) continue;
      if (i > 0 && intentos[i - 1] === mdl) await new Promise(r => setTimeout(r, 3000));
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${mdl}:generateContent?key=${encodeURIComponent(key)}`;
      const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 60000);
      try {
        const g = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctrl.signal,
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], tools: [{ google_search: {} }],
            generationConfig: { temperature: 0 } }) });
        const raw = await g.text();
        let d = null; try { d = JSON.parse(raw); } catch (e) { /* respuesta no JSON */ }
        if (!g.ok) {
          const msg = (d && d.error && d.error.message) || ('HTTP ' + g.status + ' ' + raw.slice(0, 150));
          const err = new Error(`${mdl}: ${msg}`);
          err.saturado = g.status === 429 || g.status === 503 || /overload|unavailable|exhausted|try again/i.test(msg);
          throw err;
        }
        const cand = ((d && d.candidates) || [])[0] || {};
        txt = ((cand.content || {}).parts || []).map(p => p.text || '').join('');
        if (!txt) throw new Error(`${mdl}: respuesta vacía${cand.finishReason ? ' (' + cand.finishReason + ')' : ''}`);
        ultimoError = null;
        break;
      } catch (e) {
        ultimoError = e.name === 'AbortError' ? new Error(`${mdl}: tardó más de 60 s`) : e;
        saturadoPrevio = ultimoError.saturado ? mdl : null;
        console.warn('[cotizador] internet IA', ultimoError.message);
      } finally { clearTimeout(to); }
    }
    if (ultimoError) throw ultimoError;
    const j = jsonDeTexto(txt);
    const crudos = j && Array.isArray(j.resultados) ? j.resultados : [];
    const tc = await tasasPEN();
    let res = crudos.map(x => {
      const moneda = String(x.moneda || '').toUpperCase().trim();
      const precio = Number(String(x.precio).replace(/[^0-9.]/g, ''));
      const tasa = tc.porMoneda[moneda];
      const urlOk = /^https?:\/\//i.test(String(x.url || '')) ? String(x.url) : null;
      if (!(precio > 0) || !tasa || esOculta(x.tienda, urlOk)) return null;
      const peruana = moneda === 'PEN' || String(x.pais || '').toUpperCase() === 'PE';
      const pen = precio * tasa;
      return { tienda: String(x.tienda || 'Tienda').slice(0, 60), url: urlOk, pais: String(x.pais || '').toUpperCase().slice(0, 2),
        moneda, precio, precio_pen: Math.round(pen * 100) / 100,
        // tiendas peruanas ya incluyen IGV; las extranjeras se llevan a precio con IGV × 1.18
        precio_pen_igv: Math.round((peruana ? pen : pen * IGV) * 100) / 100, igv_incluido: peruana };
    }).filter(Boolean);
    // descarta precios absurdos (menos de 1/3 o más de 3 veces la mediana)
    if (res.length >= 3) {
      const ord = res.map(x => x.precio_pen_igv).sort((a, b) => a - b), med = ord[Math.floor(ord.length / 2)];
      res = res.filter(x => x.precio_pen_igv >= med / 3 && x.precio_pen_igv <= med * 3);
    }
    res.sort((a, b) => a.precio_pen_igv - b.precio_pen_igv);
    const vals = res.map(x => x.precio_pen_igv);
    const resumen = vals.length ? { n: vals.length, min: vals[0], max: vals[vals.length - 1],
      mediana: vals.length % 2 ? vals[(vals.length - 1) / 2] : Math.round((vals[vals.length / 2 - 1] + vals[vals.length / 2]) / 2 * 100) / 100 } : null;
    return { disponible: true, resultados: res, resumen, actualizado: new Date().toISOString() };
  }

  // GET /api/cotizador/internet?vid=123  (la página lo pide sola al abrir un producto)
  app.get('/api/cotizador/internet', authAdmin, mCot, async (req, res) => {
    try {
      const vid = parseInt(req.query.vid, 10);
      if (!vid) return res.status(400).json({ error: 'Falta el producto' });
      const it = (await catalogo()).find(x => x.vid === vid);
      if (!it) return res.status(404).json({ error: 'Producto no encontrado' });
      let r = _inet.get(vid);
      const vigente = r && (Date.now() - r.t) < (r.data.resumen ? INTERNET_TTL : INTERNET_TTL_FALLA);
      const pideRecarga = req.query.fresh === '1' && (!r || !r.data.resumen || (req.admin && req.admin.maestro))
        && (!r || Date.now() - (r.intento || r.t) > 15000);
      if (!vigente || pideRecarga) {
        if (!_inetEnCurso.has(vid)) _inetEnCurso.set(vid, buscarInternet(it).finally(() => _inetEnCurso.delete(vid)));
        const intento = Date.now();
        try { r = { t: Date.now(), intento, data: await _inetEnCurso.get(vid) }; }
        catch (e) {
          console.warn('[cotizador] internet', vid, e.message);
          // Se muestra el motivo real (sin la clave) para poder corregirlo; se reintenta en 15 min
          const motivo = String(e.message || 'error desconocido').replace(/key=[^&\s]+/g, 'key=…').slice(0, 220);
          r = { t: Date.now() - INTERNET_TTL_FALLA + 15 * 60 * 1000, intento, data: { disponible: true, resultados: [], resumen: null, error: motivo,
            saturado: !!e.saturado } };
        }
        if (r.data.disponible !== false) _inet.set(vid, r);
      }
      const d = r.data;
      const normal = it.precio_normal;
      res.json({ ...d, comparacion: d.resumen && normal > 0 ? comparar(normal, d.resumen.mediana) : null,
        comparacion_pvp_rec: d.resumen && it.pvp_recomendado ? comparar(it.pvp_recomendado, d.resumen.mediana) : null });
    } catch (e) { console.error('[cotizador] internet', e.message); res.status(500).json({ error: 'No se pudo consultar internet: ' + e.message }); }
  });

  // catalogo también se expone para otros módulos (Precio importado lo reutiliza)
  return { catalogo, _test: { normalizar, tokens, puntuar, distancia, catalogo, precioMinimo, buscarInternet } };
};
// Exponer utilidades puras para pruebas
module.exports._puros = { normalizar, tokens, puntuar, puntajePalabra, compacto, tipoProducto, anioModelo, reglaSugerido, comparar, jsonDeTexto, esOculta };
