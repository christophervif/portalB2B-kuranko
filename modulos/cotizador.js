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

const { EMPRESAS_BI, nombreProdVar } = require('./comunes');

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

      _cat = prods.map(p => {
        const nombre = nombreProdVar(p.producto, p.variacion);
        const st = stMap[p.vid] || { disponible: 0, consignacion: 0, otros: 0, almacenes: [] };
        st.almacenes.sort((a, b) => b.disponible - a.disponible || b.cantidad - a.cantidad);
        const oferta = p.sale_price != null && Number(p.sale_price) > 0 ? Number(p.sale_price) : null;
        const categorias = (catMap[p.pid] || []).join(' | ');
        const tipo = tipoProducto(categorias, p.producto || nombre);
        return {
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
  const publico = ({ _sku, _pal, _comp, ...x }) => x;

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
      // Precio sugerido (B2C) según tipo de producto y año modelo / antigüedad de las unidades a vender
      let sug = null;
      const normal = it ? it.precio_normal : null;
      if (normal > 0 && it) {
        const rg = reglaSugerido(it.tipo, it.anio_modelo, r.edad_dias);
        let precio = normal, nota = null;
        if (r.precio_minimo == null) nota = 'sin costo registrado: se mantiene el precio normal';
        else if (r.precio_minimo >= normal) nota = 'el mínimo supera al precio normal';
        else if (rg.pct === 'min') precio = r.precio_minimo;
        else precio = Math.max(r.precio_minimo, Math.round(normal * (1 - Number(rg.pct || 0) / 100)));
        sug = { precio, tipo: it.tipo, tipo_nombre: it.tipo_nombre, regla_pct: rg.pct, motivo: rg.motivo, nota,
          topado_en_minimo: r.precio_minimo != null && precio === r.precio_minimo && rg.pct !== 'min',
          descuento_pct: Math.round((1 - precio / normal) * 1000) / 10 };
      }
      const out = {
        vid, cantidad, factor: FACTOR_MINIMO,
        precio_normal: it ? it.precio_normal : null,
        precio_minimo: r.precio_minimo,
        precio_sugerido: sug ? sug.precio : null, sugerido: sug, edad_dias: r.edad_dias,
        insuficiente: r.insuficiente, unidades_con_costo: r.unidades_con_costo,
        sin_costo: r.sin_costo, lote_mas_antiguo: r.lote_mas_antiguo,
        descuento_max_pct: it && it.precio_normal > 0 && r.precio_minimo
          ? Math.round((1 - r.precio_minimo / it.precio_normal) * 1000) / 10 : null
      };
      // El costo real y el detalle de lotes solo para el admin maestro
      if (req.admin && req.admin.maestro) {
        out.costo_prom = Math.round(r.costo_prom * 100) / 100;
        out.lotes = r.lotes;
      }
      res.json(out);
    } catch (e) { console.error('[cotizador] precio', e.message); res.status(500).json({ error: 'No se pudo calcular: ' + e.message }); }
  });

  return { _test: { normalizar, tokens, puntuar, distancia, catalogo, precioMinimo } };
};
// Exponer utilidades puras para pruebas
module.exports._puros = { normalizar, tokens, puntuar, compacto, tipoProducto, anioModelo, reglaSugerido };
