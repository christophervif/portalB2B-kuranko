// ═══════════════════════════════════════════════════════════════════════════
//  Apoyo del Creador WooCommerce (modulos/woo-creador.js) — módulo propio,
//  sin depender de Bikes:
//   · reconocerColumnas / aNumero: leer la lista de precios de la marca
//   · leerPagina / fichaDeHtml / htmlATexto / elegirImagenes: leer la web de la marca
//     (con bloqueo de direcciones internas, para que nadie use el portal para entrar a la red)
//   · llamarGemini: IA (GEMINI_API_KEY; modelo opcional en WOO_GEMINI_MODEL)
//   · tcMercado: tipo de cambio del día (USD y EUR → PEN)
// ═══════════════════════════════════════════════════════════════════════════
const net = require('net');
const dnsP = require('dns').promises;

const norm = s => String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

// ── Lista de precios ──────────────────────────────────────────────────────────
// Columnas que son tallas (S, M, L…) con cantidades → una fila por talla
const RE_TALLA = /^(xxs|xs|s|m|l|xl|xxl|xxxl|s\/m|m\/l|l\/xl|xs\/s)$/i;
// Reconoce cada columna por su encabezado: igual (1), empieza/termina igual (0.8) o lo contiene (0.6).
// Se asignan de mayor a menor puntaje; cada columna sirve para un solo campo.
function reconocerColumnas(headers, campos) {
  const map = {}, conf = {}, usados = new Set();
  const tallasCols = [];
  headers.forEach((h, i) => { const t = String(h || '').trim(); if (RE_TALLA.test(t)) tallasCols.push({ i, talla: t.toUpperCase() }); });
  if (tallasCols.length >= 2) tallasCols.forEach(t => usados.add(t.i));
  const pares = [];
  for (const [campo, sin] of Object.entries(campos)) {
    headers.forEach((h, i) => {
      if (usados.has(i)) return;
      const n = norm(h); if (!n) return;
      let s = 0;
      for (const [k, w] of sin.entries()) {
        const nw = norm(w);
        if (n === nw) { s = 1 - k * 0.001; break; }
        if (nw.length >= 3 && (n.startsWith(nw) || n.endsWith(nw))) s = Math.max(s, 0.8);
        else if (nw.length > 3 && n.includes(nw)) s = Math.max(s, 0.6);
      }
      if (s >= 0.6) pares.push({ campo, i, s });
    });
  }
  pares.sort((a, b) => b.s - a.s);
  for (const p of pares) {
    if (map[p.campo] != null || usados.has(p.i)) continue;
    map[p.campo] = p.i; conf[p.campo] = p.s; usados.add(p.i);
  }
  return { map, conf, tallas_cols: tallasCols.length >= 2 ? tallasCols : [] };
}
// "$ 1.299,90" / "1,299.90" / "4,650" / "12.500" → número
function aNumero(v) {
  if (typeof v === 'number') return v;
  let s = String(v == null ? '' : v).replace(/[^\d,.\-]/g, '');
  if (!s) return 0;
  if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  else if (/^-?\d{1,3}(,\d{3})+$/.test(s)) s = s.replace(/,/g, '');
  const c = s.lastIndexOf(','), p = s.lastIndexOf('.');
  if (c > p) s = s.replace(/\./g, '').replace(',', '.'); else s = s.replace(/,/g, '');
  const n = parseFloat(s); return isFinite(n) ? n : 0;
}

// ── Web de la marca ───────────────────────────────────────────────────────────
function ipPrivada(ip) {
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v.startsWith('::ffff:')) return ipPrivada(v.slice(7));
    return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}
const ENTIDADES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ntilde: 'ñ', Ntilde: 'Ñ', aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', uuml: 'ü', deg: '°', reg: '®', trade: '™', ndash: '–', mdash: '—', hellip: '…' };
const decodificar = t => String(t).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') { try { return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1)); } catch (x) { return m; } }
  return ENTIDADES[e] ?? ENTIDADES[e.toLowerCase()] ?? m;
});
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
// Descarga el HTML de una página (redirecciones a mano: cada salto se revisa contra direcciones internas)
async function leerPagina(url) {
  let actual = url;
  for (let salto = 0; salto < 5; salto++) {
    let u; try { u = new URL(actual); } catch (e) { throw new Error('El link no es válido'); }
    if (!/^https?:$/.test(u.protocol)) throw new Error('Solo links http(s)');
    const ips = await dnsP.lookup(u.hostname, { all: true }).catch(() => []);
    if (!ips.length || ips.some(x => ipPrivada(x.address))) throw new Error('No se pudo abrir ese dominio');
    const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 15000);
    let r;
    try { r = await fetch(u.href, { signal: ctrl.signal, redirect: 'manual', headers: { 'User-Agent': UA, 'Accept-Language': 'es,en;q=0.8' } }); }
    catch (e) { throw new Error(e.name === 'AbortError' ? 'La página tardó demasiado' : 'No se pudo abrir la página'); }
    finally { clearTimeout(to); }
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { actual = new URL(r.headers.get('location'), u).href; continue; }
    if (!r.ok) throw new Error(`La página respondió ${r.status}${r.status === 403 ? ' (la marca bloquea al portal: usa el Lector Woo Kuranko)' : ''}`);
    return { html: (await r.text()).slice(0, 4e6), url: u.href };
  }
  throw new Error('Demasiadas redirecciones');
}
const EXCLUIR_IMG = /\.svg(\?|$)|logo|share|icon|sprite|favicon|placeholder|blank|pixel|badge|flag|payment|banner|size-?guide|sizing|avatar|social/i;
// Título, descripción y fotos de una ficha de producto (JSON-LD Product, og:, <img>)
function fichaDeHtml(html, base) {
  const meta = n => { const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${n}["'][^>]*content=["']([^"']*)["']`, 'i')) || html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${n}["']`, 'i')); return m ? decodificar(m[1]).trim() : ''; };
  const abs = u => { try { return new URL(decodificar(u), base).href; } catch (e) { return null; } };
  const imgs = [], add = u => { const a = u && abs(String(u).split(' ')[0]); if (a && /^https?:/i.test(a) && !EXCLUIR_IMG.test(a) && !imgs.includes(a)) imgs.push(a); };
  let titulo = meta('og:title'), desc = '';
  for (const b of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const visitar = o => { if (!o || typeof o !== 'object') return; if (Array.isArray(o)) return o.forEach(visitar);
        if (/Product/i.test([].concat(o['@type'] || []).join())) {
          if (!titulo && o.name) titulo = decodificar(o.name);
          if (!desc && o.description) desc = decodificar(String(o.description));
          [].concat(o.image || []).forEach(i => add(typeof i === 'string' ? i : i && (i.url || i.contentUrl)));
        }
        if (o['@graph']) visitar(o['@graph']); };
      visitar(JSON.parse(b[1].trim()));
    } catch (e) {}
  }
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const srcset = (tag.match(/\b(?:data-)?srcset=["']([^"']+)["']/i) || [])[1];
    if (srcset) { const g = srcset.split(',').map(x => x.trim().split(/\s+/)).sort((a, b) => (parseInt(b[1]) || 0) - (parseInt(a[1]) || 0))[0]; if (g) add(g[0]); }
    add((tag.match(/\b(?:data-src|data-lazy-src|data-original|src)=["']([^"']+\.(?:jpe?g|png|webp)[^"']*)["']/i) || [])[1]);
    if (imgs.length >= 400) break;
  }
  if (!imgs.length) [...html.matchAll(/<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]*content=["']([^"']+)["']/gi)].forEach(m => add(m[1]));
  if (!desc) desc = meta('og:description') || meta('description');
  desc = desc.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1500);
  return { titulo: String(titulo || '').slice(0, 200), descripcion: desc, imagenes: imgs };
}
// Fotos del producto: si varias llevan el nombre de la página en el archivo, solo esas;
// de una misma foto en varios tamaños, la más grande; fuera las miniaturas.
function elegirImagenes(imgs, base) {
  const slugPag = (String(base).split('?')[0].split('/').filter(Boolean).pop() || '').toLowerCase().replace(/\.html?$/, '');
  const tam = u => { let m = u.match(/[-_/](\d{2,4})x(\d{2,4})[_.\-]/); if (m) return Math.max(+m[1], +m[2]);
    m = u.match(/[-_/](\d{3,4})_/) || u.match(/[-_](\d{3,4})w\b/) || u.match(/[?&](?:w|width)=(\d+)/); return m ? +m[1] : 800; };
  const cola = u => u.split('?')[0].split('/').pop().replace(/[-_]\d{2,4}x\d{2,4}(?=\.)/, '').toLowerCase();
  let lista = imgs;
  if (slugPag.length > 3) { const del = imgs.filter(u => cola(u).includes(slugPag)); if (del.length >= 2) lista = del; }
  const mejor = new Map();
  for (const u of lista) { const k = cola(u); const prev = mejor.get(k); if (!prev || tam(u) > tam(prev)) mejor.set(k, u); }
  const vals = [...mejor.values()], max = Math.max(0, ...vals.map(tam));
  return vals.filter(u => tam(u) >= Math.max(300, Math.min(1000, max * 0.6)));
}
// HTML → texto con saltos de línea (para leer especificaciones)
function htmlATexto(html) {
  return decodificar(String(html).replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|li|tr|h\d|dt|dd|section|table)>|<br\s*\/?>/gi, '\n').replace(/<\/t[dh]>/gi, '\t').replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

// ── IA (Gemini) ───────────────────────────────────────────────────────────────
// Prueba el modelo configurado, el que funcionó la última vez y los «flash» que la clave tiene disponibles.
// Devuelve el texto, o '' y deja el motivo en ultimoError().
let ultimoErrorIA = '', modeloOk = '', modelos = { t: 0, lista: [] };
async function modelosDisponibles(key) {
  if (Date.now() - modelos.t < 6 * 3600e3 && modelos.lista.length) return modelos.lista;
  try {
    const j = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(key)}`).then(r => r.json());
    const ver = n => (String(n).match(/(\d+(?:\.\d+)?)/) || [0, 0])[1] * 1;
    const lista = (j.models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent') && /gemini/i.test(m.name) && !/embedding|tts|image|audio|live|exp|preview|vision/i.test(m.name))
      .map(m => m.name.replace(/^models\//, '')).sort((a, b) => (/flash/.test(b) - /flash/.test(a)) || (/lite/.test(a) - /lite/.test(b)) || ver(b) - ver(a));
    if (lista.length) modelos = { t: Date.now(), lista };
  } catch (e) {}
  return modelos.lista;
}
async function llamarGemini(prompt, temperatura = 0.2, espera = 40000) {
  const key = process.env.GEMINI_API_KEY; if (!key) { ultimoErrorIA = 'Falta GEMINI_API_KEY'; return ''; }
  const limpio = m => String(m || '').replace(/^models\//, '').replace(/[^a-zA-Z0-9.\-]/g, '');
  const cola = [process.env.WOO_GEMINI_MODEL, modeloOk, ...(await modelosDisponibles(key)).slice(0, 5)].map(limpio).filter(Boolean);
  const probados = new Set(), reintentos = {}, errores = [];
  while (cola.length && probados.size < 6) {
    const mdl = cola.shift(); if (probados.has(mdl)) continue; probados.add(mdl);
    try {
      const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), espera);
      const g = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${mdl}:generateContent?key=${encodeURIComponent(key)}`, { method: 'POST', signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: temperatura, response_mime_type: 'application/json' } }) });
      clearTimeout(to);
      const j = await g.json().catch(() => ({}));
      if (!g.ok || j.error) {
        const msg = (j.error && j.error.message) || 'HTTP ' + g.status;
        // saturado: espera y reintenta el mismo modelo hasta 2 veces
        if ((g.status === 429 || g.status === 503 || /overload|exhausted|try again|high demand/i.test(msg)) && (reintentos[mdl] || 0) < 2) {
          reintentos[mdl] = (reintentos[mdl] || 0) + 1; probados.delete(mdl); cola.unshift(mdl);
          await new Promise(r => setTimeout(r, reintentos[mdl] * 3000)); continue;
        }
        errores.push(`${mdl}: ${String(msg).split('.')[0].slice(0, 90)}`);
        for (const m of String(msg).matchAll(/models\/([a-z0-9.\-]+)/gi)) if (!probados.has(limpio(m[1]))) cola.unshift(limpio(m[1]));
        continue;
      }
      const txt = ((((j.candidates || [])[0] || {}).content || {}).parts || []).map(x => x.text).join('');
      if (txt) { modeloOk = mdl; ultimoErrorIA = ''; return txt; }
      errores.push(`${mdl}: respuesta vacía`);
    } catch (e) { errores.push(`${mdl}: ${e.name === 'AbortError' ? 'tardó demasiado' : e.message}`.slice(0, 120)); }
  }
  ultimoErrorIA = (errores.length ? 'IA sin respuesta · ' + errores.join(' · ') : 'No hay modelos de Gemini disponibles para la clave').slice(0, 600);
  return '';
}

// ── Tipo de cambio del día (caché 3 h) ────────────────────────────────────────
const FUENTES_TC = [
  { nombre: 'open.er-api.com', url: 'https://open.er-api.com/v6/latest/USD', leer: d => ({ pen: +(d.rates || {}).PEN, eur: +(d.rates || {}).EUR }) },
  { nombre: 'currency-api (jsDelivr)', url: 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json', leer: d => ({ pen: +(d.usd || {}).pen, eur: +(d.usd || {}).eur }) }
];
let tcCache = null;
async function tcMercado() {
  if (tcCache && Date.now() - tcCache.t < 3 * 3600e3) return tcCache;
  for (const f of FUENTES_TC) {
    try {
      const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 6000);
      const r = await fetch(f.url, { signal: ctrl.signal }); clearTimeout(to);
      const x = f.leer(await r.json());
      if (!(x.pen > 0 && x.eur > 0)) throw new Error('sin PEN/EUR');
      return (tcCache = { usd: x.pen, eur: x.pen / x.eur, fuente: f.nombre, t: Date.now() });
    } catch (e) { console.warn(`[woo-creador] tipo de cambio (${f.nombre}):`, e.message); }
  }
  // respaldo: se vuelve a intentar en 10 min
  return tcCache || (tcCache = { usd: 3.45, eur: 3.95, fuente: 'respaldo', t: Date.now() - 3 * 3600e3 + 10 * 60e3 });
}

module.exports = { reconocerColumnas, aNumero, leerPagina, fichaDeHtml, elegirImagenes, htmlATexto, EXCLUIR_IMG, llamarGemini, ultimoError: () => ultimoErrorIA, tcMercado, ipPrivada };
