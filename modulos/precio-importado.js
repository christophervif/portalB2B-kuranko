// ═════════════════════════════════════════════════════════════════════════════
//  MÓDULO: Precio importado (pedido especial desde tiendas online)
//  Reemplaza la hoja de Google "CALCULO DE PRECIOS PARA COTIZACION".
//  La app vive en /precio-importado.html (pestaña 🌍 del panel admin).
//
//  - Tipo de cambio automático (USD→PEN y EUR→PEN) con el mismo recargo que la
//    hoja (EUR +1.5 %, USD +1 %). Se consulta a open.er-api.com y se guarda
//    en memoria 3 horas. Si falla, usa el último conocido o los de Railway.
//  - Leer link: detecta la tienda por el dominio y trata de leer nombre, precio
//    y moneda de la página (datos estructurados JSON-LD / meta). Si la tienda
//    bloquea la lectura, la app sigue funcionando: se escribe el precio a mano.
//  - El cálculo del costo y de los precios se hace en el navegador (instantáneo);
//    aquí solo se entregan las reglas para que haya una sola fuente.
//
//  Todo va protegido por authAdmin + requiereModulo('precio_importado').
//  Variables opcionales en Railway:
//    PRECIO_IMP_REGLAS  JSON con lo que cambia de REGLAS_BASE (tiendas, tramos…)
//    PRECIO_IMP_TC_USD / PRECIO_IMP_TC_EUR  tipo de cambio de respaldo (sin recargo)
// ═════════════════════════════════════════════════════════════════════════════

const dns = require('dns').promises;
const crypto = require('crypto');
const net = require('net');

// Reglas copiadas de la hoja de Google (sep 2026).
const REGLAS_BASE = {
  // Recargo sobre el tipo de cambio de mercado (hoja: GOOGLEFINANCE × 1.015 / × 1.01)
  recargo_tc: { EUR: 1.015, USD: 1.01 },
  // Compras bajo este monto (en USD) entran sin impuestos: el envío se prorratea
  // asumiendo que el pedido se llena hasta el FACTOR del límite.
  umbral_usd: 200,
  factor_llenado: 0.98,
  // Si el producto supera el umbral: (precio + envío) × este factor (impuestos)
  factor_impuestos: 1.23,
  igv: 1.18,
  // Precio MÍNIMO de la cotización = costo puesto en Lima ÷ este factor
  factor_minimo: 0.85,
  // Tiendas: moneda y envío aproximado (en su moneda). "dominios" sirve para
  // reconocerlas al pegar el link.
  tiendas: [
    // Proveedor reservado: el repo es público, así que su dominio no se escribe en claro;
    // se reconoce por el SHA-256 de una parte del dominio (hash_dominio) y se muestra con un seudónimo.
    { id: 'px', nombre: 'Ldg', moneda: 'USD', envio: 40, dominios: [], oculta: true,
      hash_dominio: 'dadcbf7ab5c56f9373fef3f15634a9ad17b2ea99537562ac346bfc98fdb36aa4' },
    { id: 'bike24',         nombre: 'Bike24',         moneda: 'EUR', envio: 70,  dominios: ['bike24'] },
    { id: 'bikecomponents', nombre: 'Bike-components',moneda: 'EUR', envio: 30,  dominios: ['bike-components'] },
    { id: 'bikediscount',   nombre: 'Bike-discount',  moneda: 'EUR', envio: 40,  dominios: ['bike-discount'] },
    { id: 'bikeinn',        nombre: 'Bikeinn',        moneda: 'PEN', envio: 100, dominios: ['tradeinn', 'bikeinn'] },
    { id: 'r2bike',         nombre: 'R2-bike',        moneda: 'EUR', envio: 40,  dominios: ['r2-bike'] },
    { id: 'ebay',           nombre: 'eBay',           moneda: 'USD', envio: 50,  dominios: ['ebay'] }
  ],
  // Tres propuestas de precio (las tres columnas de la hoja). Tramos: [costo hasta, %]
  precios: {
    // "Precio MÁXIMO etiqueta": costo + % por tramo; > S/ 40 redondea a la decena.
    etiqueta: { tramos: [[10, 40], [60, 80], [100, 60], [840, 40]], resto: 30, minimo: 0.9 },
    // "Según excel": costo ÷ (1 − margen) × IGV
    margen:   { tramos: [[90, 45], [190, 35], [270, 30]], resto: 25 },
    // Columna P: costo + % por tramo (más alto)
    alto:     { tramos: [[10, 250], [60, 90], [100, 70], [840, 50]], resto: 40 }
  }
};

let REGLAS = REGLAS_BASE;
try {
  if (process.env.PRECIO_IMP_REGLAS) {
    const extra = JSON.parse(process.env.PRECIO_IMP_REGLAS);
    REGLAS = { ...REGLAS_BASE, ...extra, precios: { ...REGLAS_BASE.precios, ...(extra.precios || {}) } };
  }
} catch (e) { console.warn('[precio-importado] PRECIO_IMP_REGLAS no es JSON válido, se usan las reglas base:', e.message); }

// ── Tipo de cambio ────────────────────────────────────────────────────────────
const TC_TTL = 3 * 60 * 60 * 1000;
let tcCache = null; // { usd, eur, fecha, fuente, t }

// Fuentes de tipo de cambio (de mercado, sin recargo). Se prueban en orden.
const FUENTES_TC = [
  { nombre: 'open.er-api.com', url: 'https://open.er-api.com/v6/latest/USD',
    leer: d => ({ pen: +(d.rates || {}).PEN, eur: +(d.rates || {}).EUR, fecha: d.time_last_update_utc }) },
  { nombre: 'currency-api (jsDelivr)', url: 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json',
    leer: d => ({ pen: +(d.usd || {}).pen, eur: +(d.usd || {}).eur, fecha: d.date }) },
  { nombre: 'currency-api (Cloudflare)', url: 'https://latest.currency-api.pages.dev/v1/currencies/usd.json',
    leer: d => ({ pen: +(d.usd || {}).pen, eur: +(d.usd || {}).eur, fecha: d.date }) }
];
async function tipoCambio() {
  if (tcCache && Date.now() - tcCache.t < TC_TTL) return tcCache;
  for (const f of FUENTES_TC) {
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 6000);
      const r = await fetch(f.url, { signal: ctrl.signal });
      clearTimeout(to);
      const x = f.leer(await r.json());
      if (!(x.pen > 0 && x.eur > 0)) throw new Error('respuesta sin PEN/EUR');
      tcCache = { usd: x.pen, eur: x.pen / x.eur, fecha: x.fecha || new Date().toUTCString(), fuente: f.nombre, t: Date.now() };
      return tcCache;
    } catch (e) { console.warn(`[precio-importado] tipo de cambio (${f.nombre}):`, e.message); }
  }
  if (!tcCache || tcCache.fuente.startsWith('respaldo')) tcCache = {
    usd: +process.env.PRECIO_IMP_TC_USD || 3.45,
    eur: +process.env.PRECIO_IMP_TC_EUR || 3.95,
    fecha: null, fuente: 'respaldo (Railway)', t: Date.now() - TC_TTL + 10 * 60 * 1000 // reintenta en 10 min
  };
  return tcCache;
}

// ── Leer link ─────────────────────────────────────────────────────────────────
function tiendaDeUrl(u) {
  const host = u.hostname.toLowerCase();
  const path = u.pathname.toLowerCase();
  const sha = x => crypto.createHash('sha256').update(x).digest('hex');
  const partes = host.split('.');
  for (const t of REGLAS.tiendas) {
    if (t.hash_dominio && partes.some(p => sha(p) === t.hash_dominio)) return t.id;
    if ((t.dominios || []).some(d => host.includes(d) || (d === 'bikeinn' && path.includes('/bikeinn')))) return t.id;
  }
  return null;
}

function ipPrivada(ip) {
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v.startsWith('::ffff:')) return ipPrivada(v.slice(7));
    return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
         (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

const decodificar = s => String(s || '')
  .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).trim();

// "1.234,56" / "1,234.56" / "584.03" → número
function aNumero(v) {
  if (typeof v === 'number') return v;
  let s = String(v || '').replace(/[^\d.,]/g, '');
  if (!s) return null;
  const c = s.lastIndexOf(','), p = s.lastIndexOf('.');
  if (c > p) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  const n = parseFloat(s);
  return isFinite(n) && n > 0 ? n : null;
}

function meta(html, nombre) {
  const re1 = new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${nombre}["'][^>]*content=["']([^"']*)["']`, 'i');
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name|itemprop)=["']${nombre}["']`, 'i');
  const m = html.match(re1) || html.match(re2);
  return m ? decodificar(m[1]) : null;
}

// Busca un Product con offers en los bloques JSON-LD
function productoJsonLd(html) {
  const bloques = [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)];
  const visitar = (o, out) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) return o.forEach(x => visitar(x, out));
    const tipo = [].concat(o['@type'] || []).join(',');
    if (/Product/i.test(tipo) && o.offers) out.push(o);
    if (o['@graph']) visitar(o['@graph'], out);
    if (o.hasVariant) visitar(o.hasVariant, out);
  };
  const productos = [];
  // Códigos del producto (SKU del fabricante, MPN, EAN/GTIN): sirven para encontrarlo en el sistema
  const codigos = new Set();
  const tomar = o => { if (!o || typeof o !== 'object') return;
    ['sku', 'mpn', 'gtin', 'gtin8', 'gtin12', 'gtin13', 'gtin14', 'productID'].forEach(k => {
      [].concat(o[k] || []).forEach(v => { const t = String(v).trim(); if (t.length >= 4 && t.length <= 40) codigos.add(t); }); }); };
  for (const b of bloques) {
    try { visitar(JSON.parse(b[1].trim()), productos); } catch (e) { /* JSON-LD roto: se ignora */ }
  }
  productos.forEach(p => { tomar(p); [].concat(p.offers || []).forEach(tomar); [].concat(p.hasVariant || []).forEach(tomar); });
  for (const p of productos) {
    const ofertas = [].concat(p.offers || []).flatMap(o => o && o.offers ? [].concat(o.offers) : [o]);
    for (const o of ofertas) {
      if (!o) continue;
      const precio = aNumero(o.price ?? o.lowPrice ?? (o.priceSpecification && o.priceSpecification.price));
      const moneda = o.priceCurrency || (o.priceSpecification && o.priceSpecification.priceCurrency) || null;
      if (precio) {
        const img = [].concat(p.image || [])[0];
        const marca = p.brand && (typeof p.brand === 'string' ? p.brand : p.brand.name);
        return { nombre: decodificar(p.name), precio, moneda, imagen: typeof img === 'string' ? img : (img && img.url) || null,
          marca: marca ? decodificar(marca) : null, codigos: [...codigos] };
      }
    }
  }
  return null;
}

async function leerLink(url) {
  let u;
  try { u = new URL(url); } catch (e) { throw new Error('El link no es válido'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Solo links http(s)');
  const res = { url: u.href, tienda: tiendaDeUrl(u), nombre: null, precio: null, moneda: null, imagen: null, marca: null, codigos: [], leido: false };

  // No dejar que el servidor consulte direcciones internas
  const ips = await dns.lookup(u.hostname, { all: true }).catch(() => []);
  if (!ips.length || ips.some(x => ipPrivada(x.address))) { res.aviso = 'No se pudo abrir ese dominio'; return res; }

  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 9000);
    const r = await fetch(u.href, {
      signal: ctrl.signal, redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'es-PE,es;q=0.9,en;q=0.8'
      }
    });
    clearTimeout(to);
    if (!r.ok) { res.aviso = `La tienda no dejó leer la página (${r.status}). Escribe el precio a mano.`; return res; }
    const html = (await r.text()).slice(0, 3_000_000);

    const p = productoJsonLd(html);
    if (p) Object.assign(res, p);
    res.nombre = res.nombre || meta(html, 'og:title') || decodificar((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]);
    res.imagen = res.imagen || meta(html, 'og:image');
    if (!res.precio) {
      res.precio = aNumero(meta(html, 'product:price:amount') || meta(html, 'og:price:amount') || meta(html, 'price'));
      res.moneda = res.moneda || meta(html, 'product:price:currency') || meta(html, 'og:price:currency') || meta(html, 'priceCurrency');
    }
    if (res.moneda) res.moneda = String(res.moneda).toUpperCase();
    // Proveedor reservado: quitar el nombre de la tienda que suele venir al final del título ("… | Tienda")
    const t = REGLAS.tiendas.find(x => x.id === res.tienda);
    if (t && t.oculta && res.nombre) res.nombre = res.nombre.split(/\s+[|·–—-]\s+/)[0].trim();
    // Más códigos: microdatos (itemprop) y textos tipo "SKU: …", "MPN …", "EAN …", "Art.-Nr. …", "Referencia …"
    const cods = new Set(res.codigos || []);
    for (const m of html.matchAll(/itemprop=["'](?:sku|mpn|gtin\d*|productID)["'][^>]*content=["']([^"']{4,40})["']/gi)) cods.add(decodificar(m[1]));
    const texto = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    for (const m of texto.matchAll(/\b(?:SKU|MPN|EAN|GTIN|UPC|Ref(?:erencia|erence)?\.?|C[oó]digo|Art(?:ikel)?\.?\s?-?\s?Nr\.?|Item\s?(?:No|#)|Part\s?(?:No|Number)|Herstellernummer|Manufacturer\s?(?:Part\s?)?(?:No|Number))\s*[:#.]?\s*([A-Z0-9][A-Z0-9\-./]{3,30})/gi)) {
      if (/\d/.test(m[1])) cods.add(m[1].replace(/[.\-/]+$/, ''));
      if (cods.size > 12) break;
    }
    res.codigos = [...cods].slice(0, 12);
    res.leido = !!res.precio;
    if (!res.precio) res.aviso = 'No encontré el precio en la página. Escríbelo a mano.';
  } catch (e) {
    res.aviso = e.name === 'AbortError' ? 'La tienda tardó demasiado. Escribe el precio a mano.' : 'No se pudo leer la página. Escribe el precio a mano.';
  }
  return res;
}

// ── Comparar con lo registrado en el sistema ─────────────────────────────────
// Palabras que no ayudan a encontrar el producto (títulos de tiendas online)
const RUIDO = new Set(['de','del','la','el','los','las','con','para','y','en','the','and','for','with','of',
  'a','an','mm','cm','kg','g','bike','bikes','bicycle','bicicleta','cycling','ciclismo','mtb','shop','tienda',
  'comprar','buy','online','precio','oferta','new','nuevo','nueva','r2','bike24','bikeinn','ebay',
  'components','discount','tradeinn','versandkostenfrei','kostenlos','envio','gratis']);

// Puntaje por nombre "en las dos direcciones": qué parte de las palabras buscadas está en el
// producto (65 %) y qué parte del nombre del producto está en lo buscado (35 %). Las palabras con
// números (modelos: 1275, 29, 12v…) y la marca pesan más. Tolera errores, sinónimos y palabras pegadas.
function puntuarLargo(consulta, item, P) {
  const sku = P.puntuar(consulta, item);
  if (sku >= 70) return sku;
  const peso = t => /\d/.test(t) ? 1.6 : t.length <= 2 ? 0.6 : 1;
  const qs = P.tokens(consulta).filter(t => t.length >= 2 && !RUIDO.has(t));
  if (!qs.length) return sku;
  const marca = item._pal[0];
  let suma = 0, total = 0, faltan = 0;
  for (const q of qs) {
    const w = peso(q) * (q === marca ? 1.3 : 1);
    const pp = P.puntajePalabra(q, item._pal, item._comp);
    suma += pp * w; total += w;
    // palabra de modelo (con números o código corto tipo DHF/XT/GX) que no está: resta
    if (pp < 0.5 && !/^(19|20)\d\d$/.test(q) && (/\d/.test(q) || (q.length <= 4 && q.length >= 2))) faltan++;
  }
  const ida = suma / total;
  // vuelta: palabras del producto que aparecen en lo buscado
  const qComp = P.compacto(consulta), qSet = qs;
  const pals = [...new Set(item._pal.filter(w => w.length >= 2 && !RUIDO.has(w)))];
  let s2 = 0, t2 = 0;
  for (const w of pals) { const pw = peso(w); t2 += pw; s2 += (P.puntajePalabra(w, qSet, qComp) >= 0.75 ? 1 : 0) * pw; }
  const vuelta = t2 ? s2 / t2 : 0;
  let sc = ida * 65 + vuelta * 35 - Math.min(25, faltan * 5);
  // si el nombre del producto entero está dentro de lo buscado (o al revés), sube
  if (item._comp.length >= 6 && (qComp.includes(item._comp) || item._comp.includes(qComp))) sc = Math.max(sc, 85);
  return Math.max(sku, Math.round(sc));
}

module.exports = function registrarPrecioImportado({ app, authAdmin, requiereModulo, prodPool, VV, catalogo, buscarInternet }) {
  const mPI = requiereModulo('precio_importado');
  const P = require('./cotizador')._puros;

  app.get('/api/precio-importado/config', authAdmin, mPI, async (req, res) => {
    const tc = await tipoCambio();
    res.json({
      reglas: REGLAS,
      tc: {
        usd_mercado: tc.usd, eur_mercado: tc.eur,
        USD: +(tc.usd * REGLAS.recargo_tc.USD).toFixed(4),
        EUR: +(tc.eur * REGLAS.recargo_tc.EUR).toFixed(4),
        fecha: tc.fecha, fuente: tc.fuente
      }
    });
  });

  // Códigos extra del ERP (EAN, código de barras, MPN…): se detectan las columnas que existan
  // en product_variations y se guardan en memoria 10 minutos.
  let _cods = null, _codsAt = 0;
  async function codigosErp() {
    if (_cods && Date.now() - _codsAt < 10 * 60 * 1000) return _cods;
    const mapa = new Map(); // código compacto → [vid]
    try {
      const [cols] = await prodPool.query(`
        SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'product_variations'
          AND COLUMN_NAME REGEXP 'barcode|ean|gtin|upc|mpn|isbn|part_number|manufacturer_code|codigo|reference'
          AND DATA_TYPE IN ('varchar','char','text','tinytext','bigint','int')`);
      const nombres = cols.map(r => r.c).filter(c => /^[a-z0-9_]+$/i.test(c)).slice(0, 6);
      if (nombres.length) {
        const [rows] = await prodPool.query(`SELECT id, ${nombres.map(c => '`' + c + '`').join(', ')} FROM product_variations WHERE deleted_at IS NULL`);
        rows.forEach(r => nombres.forEach(c => {
          const v = P.compacto(r[c]); if (v.length >= 5) { const a = mapa.get(v) || []; a.push(r.id); mapa.set(v, a); }
        }));
      }
    } catch (e) { console.warn('[precio-importado] códigos del ERP:', e.message); }
    _cods = mapa; _codsAt = Date.now();
    return mapa;
  }
  // Nombres de los productos padre (para agrupar variantes)
  async function nombresPadre(pids) {
    const m = {};
    if (!pids.length) return m;
    try {
      const [rows] = await prodPool.query('SELECT id, name FROM products WHERE id IN (?)', [pids]);
      rows.forEach(r => { m[r.id] = r.name; });
    } catch (e) { /* sin nombres de padre: se usa el de la primera variante */ }
    return m;
  }
  const fichaItem = (it, score, via) => ({
    vid: it.vid, pid: it.pid, sku: it.sku, nombre: it.nombre, imagen: it.imagen, score, via: via || null,
    precio_normal: it.precio_normal, precio_regular: it.precio_regular || null, precio_oferta: it.precio_oferta || null,
    pvp_recomendado: it.pvp_recomendado || null,
    ultimo_costo: it._costo_ultimo ?? it._costo ?? null, fecha_ultima_compra: it._fecha_ultima_compra || null,
    stock: it.stock, stock_total: it.stock_total
  });
  // Últimas ventas reales (precio efectivo = total / cantidad) de varios productos a la vez
  const f10 = d => d ? (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10) : null;
  async function ventasRecientes(vids) {
    const m = {};
    if (!vids.length) return m;
    try {
      const [rows] = await prodPool.query(`
        SELECT si.product_variation_id AS vid, s.created_at AS fecha, si.quantity AS cant, si.total
        FROM sale_items si JOIN sales s ON s.id = si.sale_id
        WHERE si.product_variation_id IN (?) AND s.deleted_at IS NULL AND s.status IN ${VV}
          AND si.quantity > 0 AND si.total > 0
        ORDER BY s.created_at DESC LIMIT 400`, [vids]);
      rows.forEach(r => { const a = m[r.vid] = m[r.vid] || [];
        if (a.length < 4) a.push({ fecha: f10(r.fecha), precio: Math.round(+r.total / +r.cant * 100) / 100, cant: +r.cant }); });
    } catch (e) { console.warn('[precio-importado] ventas recientes:', e.message); }
    return m;
  }

  // Busca el producto en el sistema:
  //  1) por código (SKU/MPN/EAN de la página y códigos con números del nombre) → exacto
  //  2) por nombre (difuso, en las dos direcciones) → opciones agrupadas por producto padre
  //     (variantes juntas; los productos simples van solos), marcando las de alto parecido.
  app.get('/api/precio-importado/buscar', authAdmin, mPI, async (req, res) => {
    try {
      // Medidas escritas distinto: 29" x 2.50" → 29x2.5 (como suelen estar en el sistema)
      const q = String(req.query.q || '').trim().slice(0, 200)
        .replace(/(\d)\s*(?:["”″]|''|in\b|inch\b)/gi, '$1')
        .replace(/(\d)\s*[x×]\s*(\d)/gi, '$1x$2')
        .replace(/(\d+\.\d*?[1-9])0+\b|(\d+)\.0+\b/g, (m, a, b) => a || b);
      const codigosIn = String(req.query.codigos || '').split(',').map(x => x.trim()).filter(Boolean).slice(0, 12);
      if ((!q && !codigosIn.length) || !catalogo || !prodPool) return res.json({ modo: 'nada', exactos: [], grupos: [] });
      const cat = await catalogo();
      const porVid = new Map(cat.map(it => [it.vid, it]));

      // 1) Códigos: los de la página + palabras del nombre con letras y números (≥ 5), p. ej. "XG-1275"
      const candidatos = new Set(codigosIn.map(c => P.compacto(c)).filter(c => c.length >= 4));
      (q.match(/\b[A-Za-z0-9][A-Za-z0-9\-./]{3,}\b/g) || []).forEach(w => {
        const c = P.compacto(w); if (c.length >= 5 && /\d/.test(c) && /[a-z]/.test(c)) candidatos.add(c); });
      const exactos = new Map();
      if (candidatos.size) {
        const cods = await codigosErp();
        for (const c of candidatos) {
          const desdePagina = codigosIn.some(x => P.compacto(x) === c);
          (cods.get(c) || []).forEach(vid => { const it = porVid.get(vid); if (it) exactos.set(vid, fichaItem(it, 100, 'código ' + c.toUpperCase())); });
          for (const it of cat) {
            if (!it._sku || exactos.has(it.vid)) continue;
            if (it._sku === c) exactos.set(it.vid, fichaItem(it, 100, 'SKU'));
            else if (desdePagina && c.length >= 6 && it._sku.length >= 6 && (it._sku.includes(c) || c.includes(it._sku)))
              exactos.set(it.vid, fichaItem(it, 92, 'SKU parecido'));
          }
        }
      }

      // 2) Nombre
      const puntajes = [];
      if (q) for (const it of cat) { const sc = puntuarLargo(q, it, P); if (sc >= 40) puntajes.push([sc, it]); }
      puntajes.sort((a, b) => b[0] - a[0] || b[1].stock_total - a[1].stock_total);
      const grupos = new Map();
      for (const [sc, it] of puntajes.slice(0, 80)) {
        const k = it.pid || ('v' + it.vid);
        if (!grupos.has(k)) grupos.set(k, { pid: it.pid, score: sc, puntos: new Map() });
        grupos.get(k).puntos.set(it.vid, sc);
      }
      const top = [...grupos.values()].sort((a, b) => b.score - a.score).slice(0, 6);
      const padres = await nombresPadre(top.map(g => g.pid).filter(Boolean));
      const salida = top.map(g => {
        // todas las variantes del mismo padre (aunque no hayan calzado), ordenadas por parecido
        const hermanos = g.pid ? cat.filter(it => it.pid === g.pid) : [porVid.get([...g.puntos.keys()][0])];
        const items = hermanos.map(it => fichaItem(it, g.puntos.get(it.vid) || puntuarLargo(q, it, P)))
          .sort((a, b) => b.score - a.score || b.stock_total - a.stock_total).slice(0, 30);
        return { pid: g.pid, nombre: (g.pid && padres[g.pid]) || items[0].nombre, score: g.score,
          tipo: items.length > 1 ? 'variable' : 'simple', alto: g.score >= 70, items };
      });
      const ex = [...exactos.values()].sort((a, b) => b.score - a.score).slice(0, 10);
      // no repetir abajo un producto simple que ya salió por código
      const grupos2 = salida.filter(g => !(g.tipo === 'simple' && exactos.has(g.items[0].vid)));
      // Referencias de venta: últimas ventas de cada opción y, por grupo, las del producto (todas sus variantes)
      const todos = [...ex, ...grupos2.flatMap(g => g.items)];
      const vtas = await ventasRecientes([...new Set(todos.map(x => x.vid))]);
      todos.forEach(x => { x.ventas = vtas[x.vid] || []; });
      grupos2.forEach(g => { g.ventas = g.items.flatMap(x => x.ventas).sort((a, b) => String(b.fecha).localeCompare(String(a.fecha))).slice(0, 4); });
      res.json({ modo: ex.length ? 'codigo' : grupos2.length ? 'nombre' : 'nada', codigos: [...candidatos], exactos: ex, grupos: grupos2 });
    } catch (e) { console.error('[precio-importado] buscar', e.message); res.status(500).json({ error: 'No se pudo buscar: ' + e.message }); }
  });

  // Lo registrado de un producto: compras (lotes con su costo) y ventas reales
  app.get('/api/precio-importado/historial', authAdmin, mPI, async (req, res) => {
    try {
      const vid = parseInt(req.query.vid, 10);
      if (!vid || !prodPool) return res.status(400).json({ error: 'Falta el producto' });
      const cat = catalogo ? await catalogo() : [];
      const it = cat.find(x => x.vid === vid) || null;
      const f10 = d => d ? (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10) : null;

      // Compras: todos los lotes (también los ya vendidos) con costo > 0
      const [lotes] = await prodPool.query(`
        SELECT entry_date, cost_price, initial_quantity, quantity
        FROM stock_batches
        WHERE product_variation_id = ? AND cost_price > 0
        ORDER BY entry_date DESC, id DESC LIMIT 50`, [vid]).catch(async e => {
          // por si la columna initial_quantity no existe en el ERP
          if (!/initial_quantity/.test(e.message)) throw e;
          return prodPool.query(`
            SELECT entry_date, cost_price, NULL AS initial_quantity, quantity
            FROM stock_batches WHERE product_variation_id = ? AND cost_price > 0
            ORDER BY entry_date DESC, id DESC LIMIT 50`, [vid]);
        });
      const costos = lotes.map(l => +l.cost_price);
      const compras = lotes.length ? {
        n: lotes.length,
        ultimo: { costo: +lotes[0].cost_price, fecha: f10(lotes[0].entry_date) },
        min: Math.min(...costos), max: Math.max(...costos),
        prom: costos.reduce((a, b) => a + b, 0) / costos.length,
        lotes: lotes.slice(0, 5).map(l => ({ fecha: f10(l.entry_date), costo: +l.cost_price,
          cantidad: l.initial_quantity != null ? +l.initial_quantity : null, quedan: +l.quantity }))
      } : null;

      // Ventas reales de los últimos 24 meses (precio efectivo = total / cantidad)
      const [vs] = await prodPool.query(`
        SELECT s.created_at AS fecha, si.quantity AS cant, si.total
        FROM sale_items si JOIN sales s ON s.id = si.sale_id
        WHERE si.product_variation_id = ? AND s.deleted_at IS NULL AND s.status IN ${VV}
          AND si.quantity > 0 AND si.total > 0
          AND s.created_at >= DATE_SUB(NOW(), INTERVAL 24 MONTH)
        ORDER BY s.created_at DESC LIMIT 200`, [vid]);
      let ventas = null;
      if (vs.length) {
        const unit = vs.map(v => +v.total / +v.cant);
        const uds = vs.reduce((a, v) => a + +v.cant, 0);
        ventas = {
          n: vs.length, unidades: uds,
          prom: vs.reduce((a, v) => a + +v.total, 0) / uds,
          min: Math.min(...unit), max: Math.max(...unit),
          ultimo: { precio: unit[0], fecha: f10(vs[0].fecha) },
          lista: vs.slice(0, 8).map((v, i) => ({ fecha: f10(v.fecha), precio: Math.round(unit[i] * 100) / 100, cant: +v.cant }))
        };
      }
      res.json({
        producto: it ? { vid: it.vid, sku: it.sku, nombre: it.nombre, imagen: it.imagen,
          precio_normal: it.precio_normal, precio_regular: it.precio_regular, precio_oferta: it.precio_oferta,
          pvp_recomendado: it.pvp_recomendado || null,
          stock: it.stock, stock_total: it.stock_total } : { vid },
        compras, ventas
      });
    } catch (e) { console.error('[precio-importado] historial', e.message); res.status(500).json({ error: 'No se pudo leer el historial: ' + e.message }); }
  });

  // ── Precio de mercado ──────────────────────────────────────────────────────
  // Usa la misma búsqueda con IA + Google del Cotizador (excluye las tiendas ocultas).
  // Primero tiendas de PERÚ (ya con IGV); si no hay, el resto de internet en soles × 1.18.
  // Caché en memoria por nombre: 7 días si encontró, 15 min si falló o no encontró.
  const cacheMercado = new Map();
  const mediana = v => { const o = [...v].sort((a, b) => a - b), n = o.length;
    return n ? (n % 2 ? o[(n - 1) / 2] : (o[n / 2 - 1] + o[n / 2]) / 2) : null; };
  app.get('/api/precio-importado/mercado', authAdmin, mPI, async (req, res) => {
    const nombre = String(req.query.nombre || '').trim().slice(0, 200);
    const sku = String(req.query.sku || '').trim().slice(0, 60);
    if (nombre.length < 4) return res.status(400).json({ error: 'Escribe el nombre del producto' });
    if (!buscarInternet) return res.json({ disponible: false, motivo: 'La búsqueda de internet del Cotizador no está disponible' });
    const clave = (nombre + '|' + sku).toLowerCase();
    const c = cacheMercado.get(clave);
    if (c && req.query.fresh !== '1' && Date.now() - c.t < (c.data.precio ? 7 * 864e5 : 15 * 60e3)) return res.json({ ...c.data, cache: true });
    try {
      const r = await buscarInternet({ nombre, sku });
      if (r && r.disponible === false) return res.json(r);
      const resultados = (r && r.resultados) || [];
      const peru = resultados.filter(x => x.igv_incluido);
      const base = peru.length ? peru : resultados;
      const med = mediana(base.map(x => x.precio_pen_igv));
      const data = { disponible: true, fuente: peru.length ? 'peru' : resultados.length ? 'internet' : null,
        precio: med != null ? Math.ceil(med) : null, n: base.length, resultados, actualizado: new Date().toISOString() };
      cacheMercado.set(clave, { t: Date.now(), data });
      res.json(data);
    } catch (e) {
      res.status(502).json({ error: 'No se pudo buscar el precio de mercado: ' + String(e.message).slice(0, 200), saturado: !!e.saturado });
    }
  });

  // ── Confirmar y copiar cotización: aviso por correo para enviarla por WhatsApp ──
  // Correo por la API de Resend (Railway bloquea SMTP en varios planes).
  // Variables: RESEND_API_KEY (obligatoria), PRECIO_IMP_EMAIL (destino, por defecto info@kuranko.pe),
  //            PRECIO_IMP_EMAIL_DESDE (remitente; si no, RESEND_FROM, igual que el resto del portal: noreply@kuranko.pe).
  const escH = t => String(t == null ? '' : t).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  app.post('/api/precio-importado/confirmar', authAdmin, mPI, async (req, res) => {
    const b = req.body || {};
    const texto = String(b.texto || '').slice(0, 3000), nombre = String(b.nombre || '').slice(0, 200);
    const precio = Number(b.precio);
    if (!texto || !(precio > 0)) return res.status(400).json({ error: 'Falta el precio' });
    const key = process.env.RESEND_API_KEY;
    const para = (process.env.PRECIO_IMP_EMAIL || 'info@kuranko.pe').split(',').map(x => x.trim()).filter(Boolean);
    if (!key) return res.json({ correo: false, error: 'Correo no configurado (falta RESEND_API_KEY en Railway)' });
    const wa = 'https://wa.me/?text=' + encodeURIComponent(texto);
    const quien = (req.admin && req.admin.usuario) || 'administrador';
    // Correo interno: resumen completo (lo arma la página) + el mensaje para el cliente.
    // Tablas con colores fijos para que se vea bien también en modo oscuro (Outlook, Gmail).
    const secciones = Array.isArray(b.secciones) ? b.secciones.slice(0, 12) : [];
    const celda = 'padding:7px 10px;border-bottom:1px solid #e5e7eb;font-size:14px;vertical-align:top;';
    const valor = v => { const t = String(v == null ? '' : v).slice(0, 600);
      return /^https?:\/\/\S+$/.test(t) ? `<a href="${escH(t)}" style="color:#1d4ed8;word-break:break-all">${escH(t.length > 70 ? t.slice(0, 70) + '…' : t)}</a>` : escH(t); };
    const bloques = secciones.map(sec => {
      const filas = (Array.isArray(sec.filas) ? sec.filas.slice(0, 20) : []).map(f => {
        const [a, v, n] = Array.isArray(f) ? f : [];
        return `<tr><td style="${celda}color:#6b7280;width:38%">${escH(a)}</td><td style="${celda}color:#111827">${valor(v)}${n ? `<div style="font-size:12px;color:#6b7280;margin-top:2px">${valor(n)}</div>` : ''}</td></tr>`;
      }).join('');
      return `<tr><td style="padding:16px 0 6px;font-size:13px;font-weight:bold;color:${sec.destacar ? '#15803d' : '#1e3a5f'};text-transform:uppercase;letter-spacing:.04em">${escH(sec.titulo)}</td></tr>
        <tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:${sec.destacar ? '#f0fdf4' : '#ffffff'};border:1px solid #e5e7eb;border-radius:8px">${filas}</table></td></tr>`;
    }).join('');
    const html = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#f3f4f6" style="background:#f3f4f6;padding:16px 0"><tr><td align="center">
      <table role="presentation" width="640" cellpadding="0" cellspacing="0" bgcolor="#ffffff" style="max-width:640px;width:100%;background:#ffffff;border-radius:12px;padding:20px;font-family:Arial,Helvetica,sans-serif;color:#111827">
        <tr><td style="font-size:20px;font-weight:bold;color:#111827">${escH(nombre || 'Cotización a pedido')}</td></tr>
        <tr><td style="font-size:14px;color:#4b5563;padding-top:4px">Cotizado en <b style="color:#15803d">S/ ${escH(precio.toLocaleString('es-PE'))}</b> · confirmado por ${escH(quien)} · ${escH(new Date().toLocaleString('es-PE', { timeZone: 'America/Lima' }))}</td></tr>
        ${bloques}
        <tr><td style="padding:18px 0 6px;font-size:13px;font-weight:bold;color:#1e3a5f;text-transform:uppercase;letter-spacing:.04em">Mensaje para el cliente</td></tr>
        <tr><td style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:8px;padding:12px 14px;font-size:15px;line-height:1.5;color:#064e3b;font-family:Arial,Helvetica,sans-serif">${escH(texto).replace(/\n/g, '<br>')}</td></tr>
        <tr><td style="padding-top:14px"><a href="${escH(wa)}" style="background:#25d366;color:#ffffff;text-decoration:none;font-weight:bold;padding:11px 18px;border-radius:8px;display:inline-block;font-size:14px">Abrir en WhatsApp</a></td></tr>
      </table></td></tr></table>`;
    try {
      const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 10000);
      const r = await fetch('https://api.resend.com/emails', { method: 'POST', signal: ctrl.signal,
        headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: process.env.PRECIO_IMP_EMAIL_DESDE || process.env.RESEND_FROM || 'Portal Kuranko <noreply@kuranko.pe>', to: para,
          subject: `Cotización a pedido: ${nombre || 'producto'} · S/ ${precio.toLocaleString('es-PE')}`, html, text: texto + '\n\n' + wa }) });
      clearTimeout(to);
      if (!r.ok) return res.json({ correo: false, error: `Resend ${r.status}: ${(await r.text()).slice(0, 200)}` });
      res.json({ correo: true, para });
    } catch (e) { res.json({ correo: false, error: e.message }); }
  });

  app.post('/api/precio-importado/leer', authAdmin, mPI, async (req, res) => {
    try { res.json(await leerLink(String((req.body && req.body.url) || '').trim())); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
};

// Para pruebas
module.exports._interno = { productoJsonLd, aNumero, tiendaDeUrl, ipPrivada, puntuarLargo, REGLAS_BASE };
