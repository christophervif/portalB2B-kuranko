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
  // Tiendas: moneda y envío aproximado (en su moneda). "dominios" sirve para
  // reconocerlas al pegar el link.
  tiendas: [
    { id: 'lordgun',        nombre: 'Lordgun',        moneda: 'USD', envio: 40,  dominios: ['lordgunbicycles'] },
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

async function tipoCambio() {
  if (tcCache && Date.now() - tcCache.t < TC_TTL) return tcCache;
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch('https://open.er-api.com/v6/latest/USD', { signal: ctrl.signal });
    clearTimeout(to);
    const d = await r.json();
    const pen = d && d.rates && +d.rates.PEN, eur = d && d.rates && +d.rates.EUR;
    if (!(pen > 0 && eur > 0)) throw new Error('respuesta sin PEN/EUR');
    tcCache = {
      usd: pen, eur: pen / eur,
      fecha: d.time_last_update_utc || new Date().toUTCString(),
      fuente: 'open.er-api.com', t: Date.now()
    };
  } catch (e) {
    console.warn('[precio-importado] no se pudo leer el tipo de cambio:', e.message);
    if (!tcCache) tcCache = {
      usd: +process.env.PRECIO_IMP_TC_USD || 3.44,
      eur: +process.env.PRECIO_IMP_TC_EUR || 3.90,
      fecha: null, fuente: 'respaldo (Railway)', t: Date.now() - TC_TTL + 10 * 60 * 1000 // reintenta en 10 min
    };
  }
  return tcCache;
}

// ── Leer link ─────────────────────────────────────────────────────────────────
function tiendaDeUrl(u) {
  const host = u.hostname.toLowerCase();
  const path = u.pathname.toLowerCase();
  for (const t of REGLAS.tiendas) {
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
  for (const b of bloques) {
    try { visitar(JSON.parse(b[1].trim()), productos); } catch (e) { /* JSON-LD roto: se ignora */ }
  }
  for (const p of productos) {
    const ofertas = [].concat(p.offers || []).flatMap(o => o && o.offers ? [].concat(o.offers) : [o]);
    for (const o of ofertas) {
      if (!o) continue;
      const precio = aNumero(o.price ?? o.lowPrice ?? (o.priceSpecification && o.priceSpecification.price));
      const moneda = o.priceCurrency || (o.priceSpecification && o.priceSpecification.priceCurrency) || null;
      if (precio) {
        const img = [].concat(p.image || [])[0];
        return { nombre: decodificar(p.name), precio, moneda, imagen: typeof img === 'string' ? img : (img && img.url) || null };
      }
    }
  }
  return null;
}

async function leerLink(url) {
  let u;
  try { u = new URL(url); } catch (e) { throw new Error('El link no es válido'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Solo links http(s)');
  const res = { url: u.href, tienda: tiendaDeUrl(u), nombre: null, precio: null, moneda: null, imagen: null, leido: false };

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
    res.leido = !!res.precio;
    if (!res.precio) res.aviso = 'No encontré el precio en la página. Escríbelo a mano.';
  } catch (e) {
    res.aviso = e.name === 'AbortError' ? 'La tienda tardó demasiado. Escribe el precio a mano.' : 'No se pudo leer la página. Escribe el precio a mano.';
  }
  return res;
}

module.exports = function registrarPrecioImportado({ app, authAdmin, requiereModulo }) {
  const mPI = requiereModulo('precio_importado');

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

  app.post('/api/precio-importado/leer', authAdmin, mPI, async (req, res) => {
    try { res.json(await leerLink(String((req.body && req.body.url) || '').trim())); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
};

// Para pruebas
module.exports._interno = { productoJsonLd, aNumero, tiendaDeUrl, ipPrivada, REGLAS_BASE };
