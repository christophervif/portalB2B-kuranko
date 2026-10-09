// ═══════════════════════════════════════════════════════════════════════════
//  MÓDULO: Bikes a pedido (bikes.kuranko.pe)
//  Tienda pública multimarca de bicicletas a pedido + panel de administración.
//
//  · Página pública: public/bikes.html (se sirve en "/" cuando el dominio es
//    bikes.kuranko.pe; ver index.js). También en /bikes.html para probar.
//  · Panel: public/bikes-admin.html (iframe "bikes-frame" en admin.html),
//    permiso 'bikes'. Las reglas de precio solo las cambia el maestro.
//  · Datos en la base del PORTAL (no toca el ERP, que es solo lectura):
//      bk_skus      una fila por SKU (marca+modelo+montaje+talla+color)
//      bk_config    reglas de precio/entrega (JSON)
//      bk_reservas  reservas de clientes (precio congelado al reservar)
//      bk_imports   historial de cargas de Excel
//  · El COSTO nunca sale en los endpoints públicos: el precio se calcula aquí.
//
//  Variables (opcionales): BIKES_EMAIL (aviso interno, def. info@kuranko.pe,ventas@kuranko.pe),
//  BIKES_GA_ID (Google Analytics 4, ej. G-XXXX), BIKES_META_PIXEL (ID del píxel de Meta),
//  BIKES_WHATSAPP (def. 51963358335), BIKES_GEMINI_MODEL (opcional; si falla se prueban otros y el que sugiera Google),
//  RESEND_API_KEY / RESEND_FROM (mismo correo que el resto del portal),
//  GEMINI_API_KEY (la misma de Importaciones; solo para leer Excel raros).
// ═══════════════════════════════════════════════════════════════════════════

const ESTADOS_SKU = ['A pedido', 'Pre-orden', 'Stock Lima'];
// Sin límite: stock -1, o 0 en una bici a pedido/pre-orden (se pide a la marca). Solo «Stock Lima» o un cupo > 0 limita.
const sinLimite = s => num(s.stock) < 0 || (num(s.stock) === 0 && s.estado !== 'Stock Lima');
const ESTADOS_RESERVA = ['Nueva', 'Confirmada con marca', 'Adelanto pagado', 'En tránsito', 'En Lima', 'Entregada', 'Cancelada'];
const MARCAS_BASE = ['Mondraker', 'Forestal', 'Atherton', 'Thömus', 'Crestline', 'Forbidden', 'Megamo', 'Steppenwolf', 'Revel'];
const TALLAS_ORDEN = ['XXS', 'XS', 'S', 'S/M', 'M', 'M/L', 'L', 'L/XL', 'XL', 'XXL', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6'];

const REGLAS_BASE = {
  tc_modo: 'auto',            // 'auto' = mercado + recargo · 'manual' = valores fijos
  recargo_usd: 1, recargo_eur: 1.5,
  tc_usd_manual: 3.49, tc_eur_manual: 4.20,
  // Calibrado con importaciones reales de Mondraker (Compras): aéreo IMP-73 y IMP-82, marítimo IMP-70.
  // Aéreo: (EXW + seguro + flete por bici) + ad valorem. Ej. Summum R: (2931+564)×1.06 ≈ US$ 3,706 real.
  // Marítimo: el flete es barato, pero el envío tiene gastos fijos (pick up, EUR.1, almacén, agente, visto bueno,
  // transporte…) que se reparten entre las bicis del envío; las e-bikes además pagan recargo IMO (baterías).
  flete_maritimo: 35, flete_aereo: 540,    // US$ por bici
  mar_fijos_envio: 1250, mar_bicis_envio: 7, mar_exw_ref: 3300, imo_envio: 200,
  // Orígenes: cada marca puede despachar desde otro lugar (UE, Reino Unido, EE. UU., Taiwán…) con su propia logística,
  // ad valorem (según tratado y certificado de origen) y días de tránsito. Lo que se deja vacío usa los valores generales.
  origenes: {
    // E-bikes fabricadas en la UE (ej. Mondraker) entran con EUR.1 y el TLC Perú-UE: ad valorem 0 (IMP-70: Crafty sin A/V).
    // Las bicis sin motor de Mondraker sí pagan 6% (no califican como origen UE).
    'Europa (UE)': { arancel_ebike: 0 },
    'Reino Unido': {},
    'Estados Unidos': { mar_min: 25, mar_max: 40, aereo_min: 5, aereo_max: 10 },
    'Taiwán': { mar_min: 40, mar_max: 55 }
  },
  marca_origen: { Mondraker: 'Europa (UE)' }, // { Marca: 'Estados Unidos' } · sin asignar = valores generales // US$ sin IGV por envío marítimo · bicis que comparten un envío · recargo IMO por envío con e-bikes
  seguro: 1.75, arancel: 6, arancel_ebike: 6, aduana: 0, // % seguro · % ad valorem bicis (8712: 6%) y e-bikes (8711.60: 6%, salvo origen con tratado) · otros gastos US$ por bici
  // IGV 16% + IPM 2% y percepción 3.5% de la importación son crédito fiscal: no van al costo
  igv: 18, adelanto: 30,                   // %
  margen_defecto: 25,
  // Cómo se calcula el precio de cada marca: 'costo' = costo + flete + aduana + margen;
  // 'pvp' = PVP sugerido de la marca × factor (IGV incluido), como hoy con Mondraker (× 1.03).
  modos: { Mondraker: 'pvp' }, factores_pvp: { Mondraker: 1.03 }, factor_pvp_defecto: 1.03,
  margenes: { Mondraker: 24, Forestal: 22, Atherton: 22, 'Thömus': 22, Crestline: 25, Forbidden: 23, Megamo: 26, Steppenwolf: 26, Revel: 23 },
  aereo_activo: true,
  // Envíos: aéreo solo si el precio final (marítimo) no pasa este tope en US$ y la marca lo acepta. Las e-bikes no vuelan (baterías).
  aereo_max_usd: 6000, aereo_marcas: {},
  // E-bikes por mar: envío individual (flete_unidad) si el margen queda ≥ margen_minimo; si no, envío en grupo (flete_grupo, mínimo grupo_min unidades por marca).
  flete_unidad: 650, flete_grupo: 300, grupo_min: 3, margen_minimo: 20,
  // Cuotas sin intereses con tarjeta: % que cobra el banco por número de cuotas (lo asume Kuranko si el margen sigue ≥ margen_minimo)
  cuotas: { 3: 5, 6: 7, 9: 9, 12: 11 },
  tarjeta_pct: 4.3, // comisión del link de pago / POS cuando pagan al contado con tarjeta
  cuotas_bancos: 'BBVA, Scotiabank y Diners Club',
  // Powerpay: acepta cualquier tarjeta de crédito; a Kuranko le cobra un % fijo y al cliente le cobra su propio interés
  powerpay_pct: 5,
  // Los costos de importación son aproximados: el margen se muestra como rango con flete/seguro/aduana ± este % y el TC ± 2%
  variacion_costos: 25,
  // Tienda: mostrar solo modelos con ficha completa (foto + descripción + especificaciones)
  solo_completos: true,
  moneda_principal: 'USD', // 'USD' = precios en dólares (saldo fijo en US$) con soles al lado; 'PEN' = en soles
  prep: 7, mar_min: 45, mar_max: 60, aereo_min: 10, aereo_max: 16, aduana_min: 4, aduana_max: 8, lima_min: 2, lima_max: 4,
  validez_horas: 48,
  extras: [
    { id: 'armado', nombre: 'Armado, ajuste de suspensión y fitting básico', precio: 0, incluido: true },
    { id: 'pedales', nombre: 'Pedales de plataforma', precio: 190 },
    { id: 'mant', nombre: 'Mantenimiento prepagado 12 meses (3 servicios)', precio: 450 }
  ]
};

// ── Utilidades puras ──────────────────────────────────────────────────────────
const num = v => { const n = Number(v); return isFinite(n) ? n : 0; };
const ceil10 = x => Math.ceil(x / 10) * 10;
const horaLima = ts => ts ? new Date(Number(ts) * 1000).toLocaleString('sv-SE', { timeZone: 'America/Lima' }).slice(0, 16) : '';
const hoyLima = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
function sumarDias(iso, d) { const t = new Date(iso + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + d); return t.toISOString().slice(0, 10); }
const norm = s => String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
const slug = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const escH = t => String(t == null ? '' : t).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const soles = n => 'S/ ' + Math.round(n).toLocaleString('es-PE');

function mezclarReglas(guardadas) {
  const g = guardadas || {};
  const r = { ...REGLAS_BASE, ...g, margenes: { ...REGLAS_BASE.margenes, ...(g.margenes || {}) },
    modos: { ...REGLAS_BASE.modos, ...(g.modos || {}) }, cuotas: g.cuotas && typeof g.cuotas === 'object' ? g.cuotas : REGLAS_BASE.cuotas, aereo_marcas: { ...(g.aereo_marcas || {}) }, factores_pvp: { ...REGLAS_BASE.factores_pvp, ...(g.factores_pvp || {}) } };
  if (!Array.isArray(r.extras)) r.extras = REGLAS_BASE.extras;
  r.origenes = { ...REGLAS_BASE.origenes, ...(g.origenes || {}) }; r.marca_origen = { ...REGLAS_BASE.marca_origen, ...(g.marca_origen || {}) };
  if (r.moneda_principal !== 'PEN') r.moneda_principal = 'USD';
  return r;
}

// Reglas con la logística del origen de la marca (si tiene uno asignado). Idempotente.
const CLAVES_ORIGEN = ['flete_aereo', 'flete_maritimo', 'mar_fijos_envio', 'mar_bicis_envio', 'mar_exw_ref', 'imo_envio', 'seguro', 'arancel', 'arancel_ebike', 'aduana', 'prep', 'mar_min', 'mar_max', 'aereo_min', 'aereo_max', 'aduana_min', 'aduana_max'];
function reglasMarca(R, marca) {
  if (R._origen !== undefined) return R;
  const o = (R.origenes || {})[(R.marca_origen || {})[marca]] || {};
  const x = { ...R, _origen: (R.marca_origen || {})[marca] || '' };
  for (const k of CLAVES_ORIGEN) if (o[k] !== undefined && o[k] !== null && o[k] !== '' && isFinite(+o[k])) x[k] = +o[k];
  return x;
}
// Precio final en soles (IGV incluido) de un SKU para un tipo de envío.
// tc = { usd, eur } en soles (ya con recargo). Devuelve también el desglose (solo admin).
function calcularPrecio(sku, envio, R, tc, margenForzado = null) {
  R = reglasMarca(R, sku.marca);
  // Precio final: en dólares redondeado a US$ 5 (moneda principal USD) o en soles redondeado a S/ 10
  const fin = usdx => R.moneda_principal === 'PEN' ? ceil10(usdx * tc.usd) : Math.round(Math.ceil(usdx / 5) * 5 * tc.usd);
  const lima = sku.estado === 'Stock Lima';
  const costoUSD = sku.moneda === 'EUR' ? num(sku.costo) * tc.eur / tc.usd : num(sku.costo);
  const ebike = esEbike(sku), aereo = envio === 'aereo';
  const flete = lima ? 0 : num(aereo ? R.flete_aereo : R.flete_maritimo);
  const av = num(ebike && R.arancel_ebike != null ? R.arancel_ebike : R.arancel) / 100;
  // Gastos fijos del envío marítimo repartidos por bici; el recargo IMO de las e-bikes se reparte entre las e-bikes del envío
  const nEnv = Math.max(1, num(R.mar_bicis_envio) || 1);
  // Reparto como en el cotizador: 40% igual por bici y 60% según su valor (una bici cara absorbe más que una barata)
  const pesoValor = num(R.mar_exw_ref) > 0 ? 0.4 + 0.6 * costoUSD / num(R.mar_exw_ref) : 1;
  const fijos = lima ? 0 : num(R.aduana) + (aereo ? 0 : num(R.mar_fijos_envio) / nEnv * pesoValor + (ebike ? num(R.imo_envio) / (envio === 'grupo' ? Math.max(1, num(R.grupo_min) || 1) : 1) : 0));
  const puesto = (costoUSD * (1 + num(R.seguro) / 100) + flete) * (1 + av) + fijos;
  const igv = 1 + num(R.igv) / 100;
  const modo = (R.modos && R.modos[sku.marca]) || 'costo';
  let pen;
  if (margenForzado != null) {
    pen = fin(puesto / (1 - margenForzado / 100) * igv);
  } else if (modo === 'pvp' && num(sku.pvp) > 0) {
    // PVP de la marca × factor = precio final con IGV (igual para marítimo y aéreo).
    const f = num(R.factores_pvp && R.factores_pvp[sku.marca] != null ? R.factores_pvp[sku.marca] : R.factor_pvp_defecto) || 1;
    const pvpUSD = sku.moneda === 'EUR' ? num(sku.pvp) * tc.eur / tc.usd : num(sku.pvp);
    // Aéreo/courier: mismo PVP × factor; si el flete más caro deja el margen bajo el mínimo, el precio mínimo lo sube (opcionesEnvio)
    pen = fin(pvpUSD * f);
  } else {
    const m = Math.min(90, num(R.margenes && R.margenes[sku.marca] != null ? R.margenes[sku.marca] : R.margen_defecto)) / 100;
    pen = fin(puesto / (1 - m) * igv);
  }
  const sinIGV = pen / igv / tc.usd;
  const ganancia = sinIGV - puesto;
  // Rango de margen: logística (todo lo que no es el costo de la bici) ± variacion_costos, y el costo de la bici ± 2% por tipo de cambio
  const v = num(R.variacion_costos ?? 25) / 100, logist = puesto - costoUSD;
  const mg = pu => sinIGV > 0 ? (sinIGV - pu) / sinIGV * 100 : 0;
  const margen_bajo = mg(costoUSD * 1.02 + logist * (1 + v)), margen_alto = mg(costoUSD * 0.98 + logist * Math.max(0, 1 - v));
  const cw = costoUSD * 1.02 + logist * (1 + v); // costo en el peor caso (para el precio mínimo)
  return { pen, cw, usd: pen / tc.usd, costoUSD, flete, fijos, av: av * 100, puesto, margen: sinIGV > 0 ? ganancia / sinIGV * 100 : 0, ganancia, margen_bajo, margen_alto, modo: margenForzado != null ? 'minimo' : modo === 'pvp' && num(sku.pvp) > 0 ? 'pvp' : 'costo' };
}

// Ficha completa = al menos una foto, descripción y especificaciones
function fichaCompleta(md = {}, skus = []) {
  const falta = [];
  if (!((md.imgs || []).length || skus.some(s => s.url_imagen))) falta.push('foto');
  if (!String(md.desc || '').trim()) falta.push('descripción');
  if (!(md.specs || []).length) falta.push('especificaciones');
  return falta;
}

// Opciones de envío de un SKU (lo que ve el cliente). mod = ajustes del modelo { aereo: 'auto'|'si'|'no' }.
const esEbike = s => s.categoria === 'E-MTB' || !!(s.motor && String(s.motor).trim());
// Precio final redondeado igual que calcularPrecio (US$ 5 o S/ 10), a partir de un valor en US$ con IGV
const finPrecio = (usdx, R, tc) => R.moneda_principal === 'PEN' ? ceil10(usdx * tc.usd) : Math.round(Math.ceil(usdx / 5) * 5 * tc.usd);
function opcionesEnvio(sku, R, tc, mod = {}, hoy = hoyLima()) {
  R = reglasMarca(R, sku.marca);
  const min = num(R.margen_minimo) / 100, igv = 1 + num(R.igv) / 100;
  // Precio mínimo para que, en el peor caso de costos y pagando la comisión f del medio de pago, quede el margen mínimo
  const piso = (p, f) => { const d = 1 - f - min; return d > 0.05 ? finPrecio(p.cw / d * igv, R, tc) : Infinity; };
  const op = (k, forzado = null) => {
    const p = calcularPrecio(sku, k, R, tc, forzado);
    const base = Math.max(p.pen, piso(p, 0));
    // Precio según cuántas cuotas elija: si la comisión del banco baja el margen del mínimo, el precio sube lo justo
    const cq = {}; let cu = 0;
    for (const [n, pct] of Object.entries(R.cuotas || {})) { const pn = Math.max(base, piso(p, num(pct) / 100)); if (isFinite(pn)) { cq[n] = pn; if (pn === base && +n > cu) cu = +n; } }
    const ppPct = num(R.powerpay_pct) / 100, ppP = ppPct > 0 ? Math.max(base, piso(p, ppPct)) : 0;
    const tjPct = num(R.tarjeta_pct) / 100, tjP = tjPct > 0 ? Math.max(base, piso(p, tjPct)) : 0; // contado con tarjeta
    const sinI = base / igv / tc.usd;
    return { k, p: base, f: calcularEntrega(sku, k, R, hoy), margen: sinI > 0 ? Math.round((sinI - p.puesto) / sinI * 1000) / 10 : 0, m0: p.margen,
      mb: sinI > 0 ? (sinI - p.cw) / sinI * 100 : 0, ma: p.margen_alto + (base > p.pen ? (base - p.pen) / base * 100 : 0),
      cu, cq, pp: !!ppP, ...(ppP ? { ppp: ppP } : {}), ...(tjP ? { tj: tjP } : {}), ...(base > p.pen ? { sub: 1 } : {}) };
  };
  if (sku.estado === 'Stock Lima') return [op('lima')];
  const out = [];
  if (esEbike(sku)) { // las e-bikes no viajan en avión
    const u = op('unidad');
    if (mod.unidad === 'si' || (mod.unidad !== 'no' && u.m0 >= num(R.margen_minimo))) out.push(u);
    else {
      out.push(op('grupo'));
      // Quien no quiere esperar al grupo: envío individual pagando un adicional, con el margen en el mínimo
      if (mod.unidad !== 'no') { const x = op('unidad', num(R.margen_minimo)); x.adicional = true; out.push(x); }
    }
  } else {
    out.push(op('maritimo'));
    // Aéreo para toda bici que no sea eléctrica, salvo que se apague para la marca o el modelo; el precio nunca baja del mínimo
    const marcaOk = !!R.aereo_activo && (R.aereo_marcas || {})[sku.marca] !== false;
    if (mod.aereo === 'si' || (mod.aereo !== 'no' && marcaOk)) out.push(op('aereo'));
  }
  // Si Kuranko tiene esa bici en tienda (stock del ERP), se ofrece entrega inmediata al mismo precio que el envío más barato
  if (num(sku.stock_kuranko) > 0 && out.length) {
    const b = out.reduce((a, o) => o.p < a.p ? o : a, out[0]);
    out.unshift({ ...b, k: 'lima', f: calcularEntrega(sku, 'lima', R, hoy), adicional: false, tienda: num(sku.stock_kuranko) });
  }
  return out;
}

// Rango de fechas estimadas de entrega en Lima (AAAA-MM-DD).
function calcularEntrega(sku, envio, R, hoy = hoyLima()) {
  R = reglasMarca(R, sku.marca);
  if (sku.estado === 'Stock Lima' || envio === 'lima') return [sumarDias(hoy, num(R.lima_min)), sumarDias(hoy, num(R.lima_max))];
  const disp = sku.fecha_disponible && sku.fecha_disponible > hoy ? sku.fecha_disponible : hoy;
  const t = envio === 'aereo' ? [num(R.aereo_min), num(R.aereo_max)] : [num(R.mar_min), num(R.mar_max)];
  return [sumarDias(disp, num(R.prep) + t[0] + num(R.aduana_min)), sumarDias(disp, num(R.prep) + t[1] + num(R.aduana_max))];
}

// ── Lectura de Excel de marcas: reconocimiento de columnas ────────────────────
const CAMPOS = {
  marca: ['marca', 'brand', 'manufacturer', 'fabricante', 'hersteller'],
  modelo: ['modelo', 'model', 'modelname', 'modelo nombre', 'producto', 'product', 'bike', 'bikemodel', 'familia modelo'],
  nombre: ['nombre', 'name', 'itemname', 'productname', 'descripcion', 'description', 'bezeichnung', 'articulo'],
  montaje: ['montaje', 'version', 'kit', 'build', 'buildkit', 'spec', 'specification', 'grupo', 'variant', 'variante', 'ausstattung'],
  anio: ['anio', 'ano', 'year', 'my', 'modelyear', 'temporada', 'season', 'modelljahr'],
  categoria: ['categoria', 'category', 'segment', 'segmento', 'familia', 'family', 'type', 'tipo', 'discipline', 'disciplina', 'kategorie'],
  aro: ['aro', 'wheel', 'wheelsize', 'rueda', 'tamanorueda', 'wheels', 'laufrad', 'llanta'],
  recorrido: ['recorrido', 'travel', 'reartravel', 'suspension', 'federweg'],
  material: ['material', 'frame', 'framematerial', 'cuadro', 'rahmen'],
  motor: ['motor', 'drive', 'motorbateria', 'motor bateria', 'battery', 'bateria', 'akku', 'antrieb'],
  talla: ['talla', 'size', 'framesize', 'tamano', 'tallacuadro', 'grosse', 'rahmengrosse'],
  color: ['color', 'colour', 'colorway', 'farbe', 'colores'],
  color_hex: ['colorhex', 'hex'],
  sku: ['sku', 'ref', 'referencia', 'code', 'codigo', 'articleno', 'article', 'articulo', 'artnr', 'ean', 'upc', 'itemno', 'itemnumber', 'partnumber', 'mpn'],
  costo: ['costo', 'cost', 'dealerprice', 'dealer', 'precioneto', 'net', 'netprice', 'wholesale', 'b2b', 'pvd', 'preciocompra', 'distributorprice', 'distributor', 'distribuidor', 'preciodistribuidor', 'ek', 'ekpreis', 'haendlerpreis', 'precio dealer', 'fob', 'fobprice'],
  moneda: ['moneda', 'currency', 'divisa', 'curr', 'wahrung'],
  pvp: ['pvp', 'msrp', 'rrp', 'retail', 'retailprice', 'precioventa', 'pvpr', 'uvp', 'pvpsugerido', 'srp'],
  stock: ['stock', 'qty', 'quantity', 'cantidad', 'disponible', 'units', 'unidades', 'qtyavailable', 'inventory', 'bestand', 'existencias'],
  estado: ['estado', 'status'],
  fecha_disponible: ['fechadisponible', 'eta', 'available', 'fecha', 'date', 'disponibilidad', 'availability', 'delivery', 'entrega', 'availabledate', 'etadate', 'arrival', 'llegada', 'liefertermin', 'verfugbarkeit', 'shipdate'],
  peso: ['peso', 'pesokg', 'weight', 'gewicht'],
  url_imagen: ['urlimagen', 'imagen', 'image', 'imageurl', 'foto', 'picture', 'bild'],
  url_ficha: ['urlficha', 'ficha', 'link', 'url', 'specsheet', 'datasheet'],
  notas: ['notas', 'notes', 'nota', 'comentario', 'comments', 'bemerkung']
};
const RE_TALLA = /^(xxs|xs|s|m|l|xl|xxl|s\/m|m\/l|l\/xl|s[1-6]|4[0-9]|5[0-9]|6[0-2])$/i;

function reconocerColumnas(headers) {
  const map = {}, conf = {}, usados = new Set();
  // Columnas que son tallas (S, M, L…) con cantidades → "tallas en columnas"
  const tallasCols = [];
  headers.forEach((h, i) => { const t = String(h || '').trim(); if (RE_TALLA.test(t)) tallasCols.push({ i, talla: t.toUpperCase() }); });
  if (tallasCols.length && tallasCols.every(t => /^S[1-6]$/.test(t.talla))) tallasCols.length = 0; // ej. Mondraker: S1–S4 = trimestres
  if (tallasCols.length >= 2) tallasCols.forEach(t => usados.add(t.i));
  // Todas las parejas (campo, columna) con su puntaje; se asignan de mayor a menor
  const pares = [];
  for (const [campo, sin] of Object.entries(CAMPOS)) {
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

function aNumero(v) {
  if (typeof v === 'number') return v;
  let s = String(v == null ? '' : v).replace(/[^\d,.\-]/g, '');
  if (!s) return 0;
  if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');       // 3.999 / 12.500 → miles
  else if (/^-?\d{1,3}(,\d{3})+$/.test(s)) s = s.replace(/,/g, '');  // 4,650 → miles
  const c = s.lastIndexOf(','), p = s.lastIndexOf('.');
  if (c > p) s = s.replace(/\./g, '').replace(',', '.'); else s = s.replace(/,/g, '');
  const n = parseFloat(s); return isFinite(n) ? n : 0;
}

const MESES = { ene: 1, jan: 1, feb: 2, mar: 3, abr: 4, apr: 4, may: 5, mai: 5, jun: 6, jul: 7, ago: 8, aug: 8, sep: 9, set: 9, oct: 10, okt: 10, nov: 11, dic: 12, dec: 12, dez: 12 };
function aFecha(v, hoy = hoyLima()) {
  if (v == null || v === '') return hoy;
  if (typeof v === 'number' && v > 20000 && v < 80000) return new Date(Math.round((v - 25569) * 864e5)).toISOString().slice(0, 10);
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  if (/inmediat|en stock|in stock|^stock$|now|ready|available|sofort|lager|disponible/i.test(s)) return hoy;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/);
  if (m) { const y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; }
  m = s.match(/(?:kw|cw|wk|week|sem(?:ana)?)\s*\.?\s*(\d{1,2})(?:\D+(\d{2,4}))?/i);
  if (m) {
    let y = m[2] ? (+m[2] < 100 ? 2000 + +m[2] : +m[2]) : +hoy.slice(0, 4);
    let iso = sumarDias(`${y}-01-04`, (+m[1] - 1) * 7);
    if (!m[2] && iso < hoy) iso = sumarDias(`${y + 1}-01-04`, (+m[1] - 1) * 7);
    return iso;
  }
  m = norm(s).match(/^([a-z]{3})[a-z]*(\d{2,4})?$/) || s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').match(/([a-z]{3})[a-z]*[\s\-\/.]*(\d{2,4})?/);
  if (m && MESES[m[1]]) {
    let y = m[2] ? (+m[2] < 100 ? 2000 + +m[2] : +m[2]) : +hoy.slice(0, 4);
    let iso = `${y}-${String(MESES[m[1]]).padStart(2, '0')}-01`;
    if (!m[2] && iso.slice(0, 7) < hoy.slice(0, 7)) {
      // Mes ya pasado sin año: si fue hace 6 meses o menos, ya está disponible; si no, es del próximo año
      const meses = (+hoy.slice(0, 4) - y) * 12 + (+hoy.slice(5, 7) - MESES[m[1]]);
      return meses <= 6 ? hoy : `${y + 1}-${iso.slice(5)}`;
    }
    return iso;
  }
  return null; // no reconocida
}

function aCategoria(s, motor) {
  const n = norm(s) + ' ' + norm(motor);
  if (/ebike|emtb|electr|pedelec|motor|wh/.test(n) && (motor || /ebike|emtb|electr|pedelec/.test(n))) return 'E-MTB';
  if (/enduro|superenduro/.test(n)) return 'Enduro';
  if (/downhill|dh|gravity/.test(n)) return 'Downhill';
  if (/hardtail|ht/.test(n)) return 'Hardtail';
  if (/xc|crosscountry|marathon|race/.test(n)) return 'XC';
  if (/gravel/.test(n)) return 'Gravel';
  if (/road|ruta|carretera/.test(n)) return 'Ruta';
  if (/trail|allmountain|am/.test(n)) return 'Trail';
  if (/kid|youth|junior|nino/.test(n)) return 'Kids';
  if (/dirt|bikepark|park|slope/.test(n)) return n.includes('dirt') ? 'Dirt' : 'Bike Park';
  const t = String(s || '').trim().toLowerCase().replace(/(^|[\s\-\/])\p{L}/gu, c => c.toUpperCase());
  return t.slice(0, 40) || 'Trail';
}
function aTalla(s) {
  let t = String(s == null ? '' : s).trim().toUpperCase();
  t = t.replace(/^SMALL$/, 'S').replace(/^MEDIUM$/, 'M').replace(/^LARGE$/, 'L').replace(/^X-?LARGE$/, 'XL').replace(/^X-?SMALL$/, 'XS');
  return t.slice(0, 10);
}

// Normaliza una fila ya mapeada (valores crudos por campo) al formato Kuranko.
function normalizarFila(r, def = {}, hoy = hoyLima()) {
  const errores = [];
  const monedaTxt = String(r.moneda || '') + ' ' + String(r.costo || '');
  const moneda = /eur|€/i.test(monedaTxt) ? 'EUR' : /usd|us\$|\$/i.test(String(r.moneda || '')) ? 'USD' : (def.moneda === 'EUR' ? 'EUR' : 'USD');
  const motor = String(r.motor || '').trim().slice(0, 120);
  const marcaTxt = String(r.marca || def.marca || '').trim();
  const marca = MARCAS_BASE.find(b => norm(b) === norm(marcaTxt)) || marcaTxt.slice(0, 60);
  let estado = String(r.estado || '').trim();
  estado = ESTADOS_SKU.find(e => norm(e) === norm(estado)) || (/lima|tienda/i.test(estado) ? 'Stock Lima' : /pre/i.test(estado) ? 'Pre-orden' : '');
  const fd = aFecha(r.fecha_disponible, hoy);
  if (r.fecha_disponible !== undefined && r.fecha_disponible !== '' && fd === null) errores.push(`fecha «${r.fecha_disponible}» no reconocida (se usa hoy)`);
  const fecha = fd || hoy;
  if (!estado) estado = fecha > hoy ? 'Pre-orden' : 'A pedido';
  // Talla al final del nombre (ej. "SUMMUM R Mullet Quasar Blue M")
  const nombre = String(r.nombre || '').trim();
  const mTalla = nombre.match(/\s(XXS|XS|S|M|L|XL|XXL|SM|ML|LXL|S\/M|M\/L|L\/XL|S[1-6])$/i);
  if (!r.talla && mTalla) r.talla = ({ SM: 'S/M', ML: 'M/L', LXL: 'L/XL' })[mTalla[1].toUpperCase()] || mTalla[1];
  if (!r.modelo && nombre) r.modelo = mTalla ? nombre.slice(0, -mTalla[0].length) : nombre;
  const f = {
    marca, modelo: String(r.modelo || '').trim().slice(0, 120), montaje: String(r.montaje || '').trim().slice(0, 80) || 'Base',
    anio: Math.round(aNumero(r.anio)) || null, categoria: aCategoria(r.categoria, motor), aro: String(r.aro || (/mullet|\bMX\b/i.test(nombre + ' ' + (r.modelo || '')) ? 'Mullet' : '29')).replace(/["”'']/g, '').trim().slice(0, 20) || '29',
    recorrido: String(r.recorrido || '').trim().slice(0, 40), material: String(r.material || '').trim().slice(0, 60), motor,
    talla: aTalla(r.talla) || 'Única', color: String(r.color || '').trim().slice(0, 80) || 'Único',
    color_hex: /^#?[0-9a-f]{6}$/i.test(String(r.color_hex || '').trim()) ? '#' + String(r.color_hex).trim().replace('#', '') : null,
    sku: String(r.sku || '').trim().slice(0, 80), costo: Math.round(aNumero(r.costo) * 100) / 100, moneda,
    pvp: Math.round(aNumero(r.pvp) * 100) / 100 || null, stock: Math.max(0, Math.round(aNumero(r.stock))),  // -1 = sin límite (a pedido)
    estado, fecha_disponible: fecha, peso: String(r.peso || '').trim().slice(0, 20),
    url_imagen: /^https?:\/\//i.test(String(r.url_imagen || '')) ? String(r.url_imagen).trim().slice(0, 500) : null,
    url_ficha: /^https?:\/\//i.test(String(r.url_ficha || '')) ? String(r.url_ficha).trim().slice(0, 500) : null,
    notas: String(r.notas || '').trim().slice(0, 500)
  };
  // Sin columna de stock (ej. order forms de marcas): la bici se pide a la marca, sin límite de unidades
  if (r.stock === undefined || r.stock === '' || r.stock === null) f.stock = def.stock_defecto != null && def.stock_defecto !== '' ? num(def.stock_defecto) : -1;
  if (!f.marca) errores.push('falta la marca');
  if (!f.modelo) errores.push('falta el modelo');
  if (!(f.costo > 0)) errores.push('falta el costo');
  return { fila: f, errores, valida: !!(f.marca && f.modelo && f.costo > 0) };
}

const claveSku = f => f.sku ? `${norm(f.marca)}|sku|${norm(f.sku)}` : `${norm(f.marca)}|${norm(f.modelo)}|${norm(f.montaje)}|${norm(f.talla)}|${norm(f.color)}`;

// Tabla de tallas por altura del ciclista (cm). Si la web de la marca la trae (IA), se usa esa; si no, una referencial.
const TALLAS_REF = { XS: [150, 162], S: [160, 170], M: [168, 178], 'M/L': [174, 183], L: [178, 188], 'L/XL': [184, 192], XL: [186, 198], XXL: [194, 205] };
function tablaTallas(tallas, datos = {}) {
  const ia = Array.isArray(datos.tallas) ? datos.tallas.filter(x => x && x.t && num(x.min) > 100 && num(x.max) > num(x.min)) : [];
  const out = [];
  for (const t of tallas) {
    const k = String(t).toUpperCase().replace(/\s+/g, '');
    const de = ia.find(x => String(x.t).toUpperCase().replace(/\s+/g, '') === k);
    if (de) out.push({ t, min: Math.round(num(de.min)), max: Math.round(num(de.max)) });
    else if (TALLAS_REF[k]) out.push({ t, min: TALLAS_REF[k][0], max: TALLAS_REF[k][1], ref: 1 });
  }
  return out.length ? out : null;
}

// Datos clave a partir de las especificaciones de la marca: recorrido delantero/trasero, material, aro (Mullet) y peso
function datosDeSpecs(specs = []) {
  const v = re => (specs.find(x => re.test(x.k)) || {}).v || '';
  const mm = t => { for (const m of String(t).matchAll(/(?<![x×\d,.])(\d{2,3})\s?mm\b(?!\s?[x×])/gi)) { const n = +m[1]; if (n >= 60 && n <= 230) return n; } return 0; };
  const cuadro = v(/^(cuadro|frame)/i), horq = v(/^(horquilla|fork)/i);
  const del = mm(horq), tras = (String(cuadro).match(/(\d{2,3})\s?mm\s*(?:de\s*)?(?:recorrido|travel)|(?:recorrido|travel)[^0-9]{0,12}(\d{2,3})\s?mm/i) || []).slice(1).find(Boolean);
  const c = /carbon|carbono/i.test(cuadro), a = /alloy|alumin|\balu\b|6061|6066|7005|7050/i.test(cuadro);
  const nd = v(/^(neum[aá]tico delantero|front tire|cubierta delantera)/i), nt = v(/^(neum[aá]tico trasero|rear tire|cubierta trasera)/i);
  const mullet = /mullet/i.test(cuadro) || (/\b29\b/.test(nd) && /27[.,]5/.test(nt));
  const peso = (v(/^(peso|weight)/i).match(/\d+[.,]?\d*\s?kg/i) || [])[0] || '';
  return { ...(del ? { rec_del: del } : {}), ...(tras ? { rec_tras: +tras } : {}), ...(c || a ? { material: c && a ? 'Carbono/Aluminio' : c ? 'Carbono' : 'Aluminio' } : {}), ...(mullet ? { aro: 'Mullet' } : {}), ...(peso ? { peso: peso.replace(',', '.') } : {}) };
}

// Adivina el color de una foto por su nombre de archivo (p. ej. …arid-carbon-r-atmos-blue_2000.jpg → «Atmos»).
const sinTildes = t => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
function colorDeFoto(url, colores) {
  if (colores.length < 2) return '';
  const arch = sinTildes(decodeURIComponent(String(url).split('?')[0].split('/').slice(-2).join(' '))).replace(/[^a-z0-9]+/g, ' ');
  const pal = new Set(arch.split(' '));
  let mejor = '', pts = 0;
  for (const c of colores) {
    const tk = sinTildes(c).split(/[^a-z0-9]+/).filter(t => t.length >= 3);
    const n = tk.filter(t => pal.has(t) || (t.length >= 5 && arch.includes(t))).length;
    if (n > pts) { pts = n; mejor = c; } else if (n && n === pts) mejor = ''; // empate: no adivina
  }
  return mejor;
}

// Agrupa SKUs (ya con precios) en modelos para la tienda pública.
function armarCatalogo(skus, R, tc, hoy = hoyLima(), mods = {}) {
  const g = new Map();
  for (const s of skus) {
    const k = s.marca + '|' + s.modelo;
    let m = g.get(k);
    if (!m) {
      m = { id: slug(s.marca + ' ' + s.modelo), marca: s.marca, modelo: s.modelo, anio: s.anio, cat: s.categoria, aro: s.aro, rec: s.recorrido, mat: s.material,
        motor: s.motor || null, peso: s.peso || null, img: s.url_imagen || null, ficha: s.url_ficha || null, montajes: [], colores: [], tallas: [], skus: [] };
      g.set(k, m);
    }
    const md = mods[k] || {};
    if (md.imgs && md.imgs.length && !m.gal) { m.gal = md.imgs; m.img = md.imgs[0]; }
    if (md.desc && !m.desc) m.desc = md.desc;
    if (md.specs && md.specs.length && !m.specs) m.specs = md.specs;
    const dSp = datosDeSpecs(md.specs || []);
    const dt = { ...dSp, ...Object.fromEntries(Object.entries(md.datos || {}).filter(([, x]) => x)) };
    if (dSp.aro || (dt.aro && /mullet/i.test(dt.aro))) m.aro = 'Mullet'; // la ficha de la marca manda sobre el Excel
    if (dt.rec_del && !m.rd) { m.rd = dt.rec_del; if (dt.rec_tras) m.rt = dt.rec_tras; }
    else if (dt.rec_tras && !m.rd && !m.rt) m.rt = dt.rec_tras; // frameset: solo el recorrido trasero
    if (dt.material && !m.matx) m.matx = dt.material;
    if (dt.geo && !m.geo) m.geo = dt.geo;
    if (dt.geometria && !m.geom) m.geom = dt.geometria;
    if (dt.recorrido && !m.rec) m.rec = dt.recorrido; if (dt.material && !m.mat) m.mat = dt.material; if (dt.peso && !m.peso) m.peso = dt.peso; if (dt.motor && !m.motor) m.motor = dt.motor;
    if (md.url_ficha && !m.ficha) m.ficha = md.url_ficha;
    if (md.confirmado) m.conf = 1;
    if (md.destacado) m.dest = 1;
    if (md.etiqueta) m.tag = md.etiqueta;
    if (!m.img && s.url_imagen) m.img = s.url_imagen;
    if (s.url_imagen) { m._ci = m._ci || {}; m._ci[s.url_imagen] = m._ci[s.url_imagen] || s.color; }
    m._md = md;
    if (!m.ficha && s.url_ficha) m.ficha = s.url_ficha;
    if (!m.motor && s.motor) m.motor = s.motor;
    if (!m.montajes.includes(s.montaje)) m.montajes.push(s.montaje);
    if (!m.colores.find(c => c.n === s.color)) m.colores.push({ n: s.color, h: s.color_hex || null });
    if (!m.tallas.includes(s.talla)) m.tallas.push(s.talla);
    const ops = opcionesEnvio(s, R, tc, md, hoy).filter(o => !o.bajo);
    if (!ops.length) continue; // no llega al margen mínimo: no se publica
    const base = ops.reduce((a, o) => o.p < a.p ? o : a, ops[0]);
    const it = { id: s.id, mo: s.montaje, t: s.talla, c: s.color, d: sinLimite(s) ? 99 : Math.max(0, num(s.stock) - num(s.reservado)), e: s.estado, ...(num(s.stock_kuranko) > 0 ? { tk: num(s.stock_kuranko) } : {}),
      pm: base.p, fm: base.f, op: ops.map(o => ({ k: o.k, p: o.p, f: o.f, cu: o.cu, cq: o.cq, ...(o.tj ? { tj: o.tj } : {}), ...(o.pp ? { pp: o.ppp } : {}), ...(o.adicional ? { ad: 1 } : {}) })) };
    if (s.pvp > 0) it.ref = Math.ceil(s.pvp * (s.moneda === 'EUR' ? tc.eur : tc.usd) / 10) * 10; // PVP de la marca en soles, referencia
    m.skus.push(it);
  }
  const ordT = t => { const i = TALLAS_ORDEN.indexOf(t); return i < 0 ? 99 : i; };
  return [...g.values()].filter(m => m.skus.length).map(m => {
    m.tallas = m.tallas.filter(t => m.skus.some(x => x.t === t)); m.colores = m.colores.filter(c => m.skus.some(x => x.c === c.n)); m.montajes = m.montajes.filter(mo => m.skus.some(x => x.mo === mo));
    m.tallas.sort((a, b) => ordT(a) - ordT(b));
    // Fotos por color: lo asignado a mano en «Modelos», si no el nombre del color en el archivo de la foto, si no la foto del Excel de ese color.
    const gal = (m.gal || []).slice(), man = (m._md && m._md.imgc) || {}, ci = m._ci || {};
    for (const u of Object.keys(ci)) if (!gal.includes(u)) gal.push(u);
    if (gal.length) {
      const gc = gal.map(u => man[u] !== undefined ? man[u] : ci[u] || colorDeFoto(u, m.colores.map(c => c.n)));
      if (gc.some(Boolean)) m.gc = gc;
      m.gal = gal; m.img = m.img || gal[0];
    }
    const tt = tablaTallas(m.tallas, (m._md && m._md.datos) || {}); if (tt) m.tt = tt;
    if (m._md && m._md.datos && m._md.datos.garantia) m.gar = String(m._md.datos.garantia).slice(0, 200);
    delete m._ci; delete m._md;
    // «Próximamente»: solo la silueta de la foto principal, sin nombre, precio ni ficha (no se puede reservar)
    if (m.tag === 'proximamente') return { id: 'pronto-' + slug(m.marca) + '-' + m.id.length + m.skus.length, marca: m.marca, cat: m.cat, aro: m.aro, tag: m.tag, img: (m.gal || [])[0] || m.img || null,
      modelo: 'Próximamente', montajes: [], colores: [], tallas: [], skus: [{ id: 0, mo: '', t: '', c: '', d: 0, pm: 0, fm: [hoy, hoy], op: [] }] };
    return m;
  });
}

// ── Tipo de cambio (misma fuente que Precio importado, caché propia) ──────────
const TC_TTL = 3 * 60 * 60 * 1000;
let tcCache = null;
const FUENTES_TC = [
  { nombre: 'open.er-api.com', url: 'https://open.er-api.com/v6/latest/USD', leer: d => ({ pen: +(d.rates || {}).PEN, eur: +(d.rates || {}).EUR }) },
  { nombre: 'currency-api (jsDelivr)', url: 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json', leer: d => ({ pen: +(d.usd || {}).pen, eur: +(d.usd || {}).eur }) },
  { nombre: 'currency-api (Cloudflare)', url: 'https://latest.currency-api.pages.dev/v1/currencies/usd.json', leer: d => ({ pen: +(d.usd || {}).pen, eur: +(d.usd || {}).eur }) }
];
async function tcMercado() {
  if (tcCache && Date.now() - tcCache.t < TC_TTL) return tcCache;
  for (const f of FUENTES_TC) {
    try {
      const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 6000);
      const r = await fetch(f.url, { signal: ctrl.signal }); clearTimeout(to);
      const x = f.leer(await r.json());
      if (!(x.pen > 0 && x.eur > 0)) throw new Error('sin PEN/EUR');
      tcCache = { usd: x.pen, eur: x.pen / x.eur, fuente: f.nombre, t: Date.now() };
      return tcCache;
    } catch (e) { console.warn(`[bikes] tipo de cambio (${f.nombre}):`, e.message); }
  }
  if (!tcCache) tcCache = { usd: 3.45, eur: 3.95, fuente: 'respaldo', t: Date.now() - TC_TTL + 10 * 60 * 1000 };
  return tcCache;
}
async function tcEfectivo(R) {
  if (R.tc_modo === 'manual') return { usd: num(R.tc_usd_manual) || 3.49, eur: num(R.tc_eur_manual) || 4.2, fuente: 'manual', mercado: null };
  const m = await tcMercado();
  return { usd: Math.round(m.usd * (1 + num(R.recargo_usd) / 100) * 10000) / 10000, eur: Math.round(m.eur * (1 + num(R.recargo_eur) / 100) * 10000) / 10000, fuente: m.fuente, mercado: { usd: m.usd, eur: m.eur } };
}

// ── Cabecera igual a kuranko.pe ───────────────────────────────────────────────
// El menú se lee de la portada de kuranko.pe (cada 6 h) para que, si cambias el
// menú en WordPress, bikes.kuranko.pe lo muestre igual. Si no se puede leer, se
// usa este respaldo (copiado de kuranko.pe el 04/10/2026).
const K = 'https://kuranko.pe';
const MENU_RESPALDO = [
  { t: 'TECNOLOGÍAS FIDLOCK', h: K + '/fidlock/', mega: true, hijos: [
    { t: 'TWIST', h: K + '/tecnologia-twist/', d: '¡TWIST es el comienzo de la revolución que liberó a la botella de su antigua jaula!' },
    { t: 'VACUUM', h: K + '/tecnologia-vacuum/', d: 'Conexión segura e ingeniosa para conectar su teléfono a la bicicleta.' },
    { t: 'HERMETIC', h: K + '/tecnologia-hermetic/', d: 'Bolsas secas con cierre magnético automático.' },
    { t: 'PINCLIP', h: K + '/tecnologia-pinclip/', d: 'Cambia la cámara de acción en segundos sin cambiar el ángulo.' },
    { t: 'SNAPSNAP', h: K + '/tecnologia-snapsnap/', d: 'El equipo adecuado en el momento adecuado.' },
    { t: 'FIDGUARD', h: K + '/tecnologia-fidguard/', d: 'Inhibe el crecimiento bacteriano dentro de la botella.' }] },
  { t: 'NAVES', h: K + '/categoria-producto/ciclismo/bicicletas/', hijos: [
    ['Cross Country', 'cross-country'], ['Cuadros', 'cuadros-bicicletas'], ['Downhill', 'downhill'], ['e-Bike Enduro / Trail', 'e-bike-enduro-trail'],
    ['e-Bike Light', 'e-bike-light'], ['Enduro / Trail', 'enduro-trail'], ['Superenduro', 'superenduro']].map(([t, c]) => ({ t, h: `${K}/categoria-producto/ciclismo/bicicletas/${c}/` }))
    .concat([{ t: 'De fábrica a pedido', h: 'https://bikes.kuranko.pe/' }]) },
  { t: 'COMPONENTES', h: K + '/categoria-producto/ciclismo/', mega: true, hijos: [
    ['SUSPENSIONES Y SHOCKS', 'amortiguador'], ['DIRECCIÓN', 'direccion'], ['FRENOS', 'frenos'], ['TRANSMISIÓN', 'transmision'], ['RUEDAS', 'ruedas'],
    ['SILLINES Y TIJAS', 'sillines-y-tijas'], ['PARTES DEL CUADRO', 'partes-para-cuadros']].map(([t, c]) => ({ t, h: `${K}/categoria-producto/ciclismo/${c}/` })) },
  { t: 'ACCESORIOS', h: K + '/categoria-producto/ciclismo/accesorios/', hijos: [
    ['Bidones & portabidones', 'bidones-portabidones'], ['Equipamiento para celulares', 'equipamiento-para-celulares-accesorios'],
    ['Equipamiento para grabar y fotografiar', 'equipamiento-para-grabar-y-fotografiar-accesorios'], ['Iluminación', 'iluminacion'],
    ['Mochilas, Bolsas y Bolsas de hidratación', 'mochilas-bolsas']].map(([t, c]) => ({ t, h: `${K}/categoria-producto/ciclismo/accesorios/${c}/` })) },
  { t: 'TALLER', h: K + '/categoria-producto/ciclismo/taller/', hijos: [
    ['Herramientas generales', 'herramientas-generales'], ['Herramientas según módulos', 'herramientas-segun-modulos'], ['Herramientas para frenos', 'herramientas-para-frenos'],
    ['Minitools', 'minitools'], ['Productos de mantenimiento & lubricantes', 'productos-de-mantenimiento-lubricantes'], ['Soportes de montaje', 'soportes-de-montaje']]
    .map(([t, c]) => ({ t, h: `${K}/categoria-producto/ciclismo/taller/${c}/` })) },
  { t: 'ROPA', h: K + '/categoria-producto/ciclismo/ropa/', hijos: [['Coderas', 'coderas'], ['Culote', 'culote'], ['Medias', 'medias'], ['Rodilleras', 'rodilleras'], ['Zapatillas', 'zapatillas']]
    .map(([t, c]) => ({ t, h: `${K}/categoria-producto/ciclismo/ropa/${c}/` })) },
  { t: 'A PEDIDO', h: K + '/categoria-producto/ciclismo/?filter_disponibilidad=a-pedido', hijos: [
    ['SUSPENSIONES Y SHOCKS', 'amortiguador'], ['DIRECCIÓN', 'direccion'], ['FRENOS', 'frenos'], ['TRANSMISIÓN', 'transmision'], ['RUEDAS', 'ruedas'], ['SILLINES Y TIJAS', 'sillines-y-tijas'],
    ['ACCESORIOS', 'accesorios'], ['ROPA', 'ropa'], ['TALLER', 'taller'], ['NAVES', 'bicicletas']].map(([t, c]) => ({ t, h: `${K}/categoria-producto/ciclismo/${c}/?filter_disponibilidad=a-pedido` })) },
  { t: 'MARKETPLACE', h: K + '/categoria-producto/marketplace/ciclismo-marketplace/', hijos: [] }
];
const ENTIDADES = { amp: '&', nbsp: ' ', quot: '"', apos: "'", lt: '<', gt: '>', ndash: '–', mdash: '—', iexcl: '¡', reg: '®' };
const decodificar = t => String(t).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1)) : (ENTIDADES[e.toLowerCase()] ?? m));
const attr = (a, n) => { const m = a.match(new RegExp('\\b' + n + '="([^"]*)"')); return m ? decodificar(m[1]) : ''; };
// Lee el <ul id="menu-main"> de la portada de kuranko.pe (tema Goya) sin dependencias.
function leerMenuKuranko(html) {
  const ini = html.indexOf('id="menu-main"'); if (ini < 0) return null;
  const desde = html.lastIndexOf('<ul', ini);
  const re = /<(\/?)([a-z][a-z0-9]*)\b([^>]*)>|<!--[\s\S]*?-->|([^<]+)/gi;
  re.lastIndex = desde;
  const raiz = []; const pilaListas = []; const pilaLi = []; let lista = null, enA = null, enLabel = 0, spans = [];
  let m;
  while ((m = re.exec(html))) {
    const [, cierre, tag0, at, texto] = m;
    if (tag0 === undefined && texto === undefined) continue; // comentario
    if (texto !== undefined) {
      const tx = decodificar(texto).replace(/\s+/g, ' ');
      if (enA && tx.trim()) { if (enLabel) enA.d = (enA.d + tx).trimStart(); else enA.t = (enA.t + tx).trimStart(); }
      continue;
    }
    const tag = tag0.toLowerCase();
    if (tag === 'ul') {
      if (!cierre) { const nueva = lista === null ? raiz : (pilaLi.length ? pilaLi[pilaLi.length - 1].hijos : raiz); pilaListas.push(lista); lista = nueva; }
      else { lista = pilaListas.pop(); if (lista === null) break; }
    } else if (tag === 'li') {
      if (!cierre) { const it = { t: '', h: '', d: '', img: '', mega: /menu-item-mega-parent/.test(attr(at, 'class')), hijos: [] }; (lista || raiz).push(it); pilaLi.push(it); }
      else pilaLi.pop();
    } else if (tag === 'a') {
      if (!cierre && pilaLi.length) { enA = pilaLi[pilaLi.length - 1]; enA.h = attr(at, 'href'); } else if (cierre) enA = null;
    } else if (tag === 'span') {
      if (!cierre) { const lab = /menu-label/.test(attr(at, 'class')); spans.push(lab); if (lab) enLabel++; }
      else if (spans.pop()) enLabel--;
    } else if (tag === 'img' && enA && !enA.img) enA.img = attr(at, 'data-src') || attr(at, 'src');
    // otras etiquetas (i, svg, b…) se ignoran
  }
  const limpiar = arr => arr.filter(i => i.t.trim() && i.h).map(i => ({ t: i.t.trim(), h: i.h, ...(i.d.trim() ? { d: i.d.trim().slice(0, 160) } : {}), ...(i.img ? { img: i.img } : {}), ...(i.mega ? { mega: true } : {}), hijos: limpiar(i.hijos) }));
  const menu = limpiar(raiz);
  return menu.length >= 3 ? menu : null;
}
let cabeceraCache = null;
async function cabeceraKuranko() {
  if (cabeceraCache && Date.now() - cabeceraCache.t < 6 * 3600e3) return cabeceraCache;
  try {
    const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 12000);
    const r = await fetch(K + '/', { signal: ctrl.signal, headers: { 'User-Agent': 'KurankoBikes/1.0 (+https://bikes.kuranko.pe)' } }); clearTimeout(to);
    const menu = leerMenuKuranko(await r.text());
    if (!menu) throw new Error('no se encontró el menú');
    cabeceraCache = { menu, fuente: 'kuranko.pe', t: Date.now() };
  } catch (e) {
    console.warn('[bikes] menú de kuranko.pe:', e.message);
    cabeceraCache = { menu: (cabeceraCache && cabeceraCache.fuente === 'kuranko.pe') ? cabeceraCache.menu : MENU_RESPALDO, fuente: cabeceraCache?.fuente === 'kuranko.pe' ? 'kuranko.pe (anterior)' : 'respaldo', t: Date.now() - 5.5 * 3600e3 };
  }
  return cabeceraCache;
}
// Archivos de kuranko.pe que se sirven desde bikes.kuranko.pe (las fuentes necesitan el mismo dominio)
const ACTIVOS = {
  'URW-DIN-normal.woff2': ['/wp-content/uploads/2023/06/URW-DIN-normal.woff2', 'font/woff2'],
  'Unvidia-Bold.woff2': ['/wp-content/uploads/2023/06/Unvidia-Bold.woff2', 'font/woff2'],
  'logo.png': ['/wp-content/uploads/2024/03/Imagotipo-2-color-1.png', 'image/png'],
  'whatsapp.png': ['/wp-content/uploads/2023/11/boton-whastapp.png', 'image/png'],
  'ubicacion.png': ['/wp-content/uploads/2023/11/geo_location_map_marker_icon_208543-1.png', 'image/png']
};
const activosCache = new Map();

// ── Leer la ficha de un modelo en la web de la marca (fotos y descripción) ─────
const dnsP = require('dns').promises;
let ipPrivada = () => false;
try { ipPrivada = require('./precio-importado')._interno.ipPrivada; } catch (e) { /* sin bloqueo extra */ }
function leerFichaHtml(html, base) {
  const meta = n => { const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${n}["'][^>]*content=["']([^"']*)["']`, 'i')) || html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${n}["']`, 'i')); return m ? decodificar(m[1]).trim() : ''; };
  const abs = u => { try { return new URL(decodificar(u), base).href; } catch (e) { return null; } };
  const imgs = [], add = u => { const a = u && abs(String(u).split(' ')[0]); if (a && /^https?:/i.test(a) && !/\.svg(\?|$)|logo|icon|sprite|favicon|placeholder|blank|pixel|badge|flag|payment|[-_]geo[-_.]|geometr|size-?guide|sizing/i.test(a) && !imgs.includes(a)) imgs.push(a); };
  let titulo = meta('og:title'), desc = '';
  // JSON-LD Product: nombre, descripción e imágenes
  for (const b of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const visitar = o => { if (!o || typeof o !== 'object') return; if (Array.isArray(o)) return o.forEach(visitar);
        if (/Product/i.test([].concat(o['@type'] || []).join())) { if (!titulo && o.name) titulo = decodificar(o.name); if (!desc && o.description) desc = decodificar(String(o.description)); [].concat(o.image || []).forEach(i => add(typeof i === 'string' ? i : i && (i.url || i.contentUrl))); }
        if (o['@graph']) visitar(o['@graph']); };
      visitar(JSON.parse(b[1].trim()));
    } catch (e) {}
  }
  // og:image suele ser una imagen genérica de la marca (logo o «share»): solo se usa si no hay otras fotos
  const og = [...html.matchAll(/<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]*content=["']([^"']+)["']/gi)].map(m => abs(m[1])).filter(u => u && !/share|default|logo/i.test(u));
  // Fotos grandes de la página (src, data-src, srcset: se toma la de mayor tamaño)
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const srcset = (tag.match(/\b(?:data-)?srcset=["']([^"']+)["']/i) || [])[1];
    if (srcset) { const ult = srcset.split(',').map(x => x.trim().split(/\s+/)).sort((a, b) => (parseInt(b[1]) || 0) - (parseInt(a[1]) || 0))[0]; if (ult) add(ult[0]); }
    add((tag.match(/\b(?:data-src|data-lazy-src|data-original|src)=["']([^"']+\.(?:jpe?g|png|webp)[^"']*)["']/i) || [])[1]);
    if (imgs.length >= 400) break;
  }
  if (!desc) desc = meta('og:description') || meta('description');
  desc = desc.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1500);
  let imagenes = elegirImagenes(imgs, base);
  if (!imagenes.length) imagenes = elegirImagenes(og, base);
  const todas = [...html.matchAll(/\b(?:data-src|data-lazy-src|src)=["']([^"']+\.(?:jpe?g|png|webp)[^"']*)["']/gi)].map(m => abs(m[1])).filter(Boolean);
  return { titulo: titulo.slice(0, 200), descripcion: desc, imagenes: imagenes.slice(0, 16), geo: fotoGeometria(todas) };
}
// De todas las fotos de la página: si varias llevan el nombre del modelo en el archivo, solo esas;
// y de cada foto repetida en varios tamaños, la más grande (ej. Mondraker: 366x250_ vs 2000_).
function elegirImagenes(imgs, base) {
  // Slug de la página sin el código final que agregan algunas marcas (ej. f-trick-26 + 6a509abeb8840)
  const slugPag = (String(base).split('?')[0].split('/').filter(Boolean).pop() || '').toLowerCase().replace(/[0-9a-f]{13}$/, '');
  const tam = u => { let m = u.match(/[-_/](\d{1,4})x(\d{1,4})_/); if (m) return Math.max(+m[1], +m[2]);
    m = u.match(/[-_/](\d{3,4})_/) || u.match(/[-_](\d{3,4})w\b/) || u.match(/[?&](?:w|width)=(\d+)/); return m ? +m[1] : 800; };
  // Clave de cada foto sin el tamaño, pero con su código único: así el mismo archivo en 366x250 y 2000 cuenta una vez,
  // y dos colores con el mismo nombre (ej. Kaoz: kaoz.jpg en dos colores, códigos distintos) cuentan como fotos distintas
  const cola = u => u.split('?')[0].split('/').pop().replace(/^\d+-[\dx]+_/i, '').replace(/[-_]\d{2,4}x\d{2,4}(?=\.)/, '').toLowerCase();
  let lista = imgs;
  if (slugPag.length > 3) { const del = imgs.filter(u => cola(u).includes(slugPag)); if (del.length >= 2) lista = del; }
  const mejor = new Map();
  for (const u of lista) { const k = cola(u); const prev = mejor.get(k); if (!prev || tam(u) > tam(prev)) mejor.set(k, u); }
  // Solo las fotos grandes: las miniaturas de menús y «otros modelos» quedan fuera (ej. 2000_ sí, 366x250_ y 300_ no)
  const vals = [...mejor.values()], max = Math.max(0, ...vals.map(tam));
  return vals.filter(u => tam(u) >= Math.max(400, Math.min(1000, max * 0.6)));
}
// HTML → texto con saltos de línea (para leer especificaciones)
function htmlATexto(html) {
  return decodificar(String(html).replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|li|tr|h\d|dt|dd|section|table)>|<br\s*\/?>/gi, '\n').replace(/<\/t[dh]>/gi, '\t').replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}
// Especificaciones sin IA: pares "Título corto" + "valor" a partir de la sección de especificaciones
function specsSimples(texto) {
  const i = inicioSpecs(texto);
  if (i < 0) return [];
  let bloque = texto.slice(i, i + 12000);
  const fin = bloque.slice(200).search(/\n\s*(Guía de tallas|Geometr[íi]a|Geometry|Size guide|Spare parts|Repuestos)\s*\n/i); // hasta donde empieza la geometría
  if (fin > 0) bloque = bloque.slice(0, fin + 200);
  const lineas = bloque.split('\n').map(l => l.trim()).filter(Boolean);
  const out = [];
  // Formato "Horquilla · Fox 38…" en una sola línea
  for (const l of lineas) { const m = l.match(/^([A-ZÁÉÍÓÚÑ][\wÁÉÍÓÚÑáéíóúñ ]{1,30}?)\s*[·:]\s+(.{3,300})$/); if (m) out.push({ k: m[1].trim(), v: m[2].trim() }); if (out.length >= 30) break; }
  if (out.length >= 4) return out;
  out.length = 0; lineas.shift();
  for (let k = 0; k < lineas.length - 1 && out.length < 30; k++) {
    const a = lineas[k], b = lineas[k + 1];
    if (a.length <= 32 && /^[A-ZÁÉÍÓÚÑa-z]/.test(a) && !/[.:]$/.test(a) && (b.length > a.length || /\d/.test(b)) && b.length < 400) { out.push({ k: a, v: b }); k++; }
  }
  return out;
}
// Descripción sin IA (si la página no trae una): se arma con las especificaciones clave
function descDeSpecs(nombre, specs) {
  const v = re => { const x = specs.find(s => re.test(s.k)); return x ? x.v.split(/[,.]/)[0].trim() : ''; };
  const partes = [[/cuadro|frame/i, 'cuadro'], [/horquilla|fork/i, 'horquilla'], [/amortiguador|shock/i, 'amortiguador'], [/motor/i, 'motor'], [/bater/i, 'batería'], [/cambio|transmisi|derailleur/i, 'transmisión'], [/freno|brake/i, 'frenos'], [/direcci[oó]n|headset/i, 'dirección'], [/potencia|stem/i, 'potencia']]
    .map(([re, n]) => { const x = v(re); return x ? `${n} ${x}` : ''; }).filter(Boolean).slice(0, 5);
  // Los framesets traen solo cuadro (y a veces amortiguador, dirección o potencia): basta con una parte
  return partes.length >= (/frameset|cuadro|frame\b/i.test(nombre) ? 1 : 2) ? `${nombre}: ${partes.join(', ')}.` : '';
}
// Con IA (Gemini): resumen de venta y datos clave a partir del texto de la página
// Dónde empiezan las especificaciones: título, o la zona donde aparecen horquilla y frenos juntos
function inicioSpecs(texto) {
  // El título de la sección, seguido de cerca por cuadro/horquilla (así no se confunde con un menú)
  for (const m of texto.matchAll(/ESPECIFICACIONES|SPECIFICATIONS|FICHA T[ÉE]CNICA|TECHNISCHE DATEN|SPECS\b/gi))
    if (/Cuadro|Frame|Rahmen|Horquilla|Fork|Gabel/i.test(texto.slice(m.index, m.index + 700))) return m.index;
  for (const m of texto.matchAll(/Horquilla|Fork\b|Gabel/g)) { const w = texto.slice(Math.max(0, m.index - 2500), m.index + 2500); if (/Freno|Brake|Bremse/.test(w) && /Cuadro|Frame|Rahmen/.test(w)) return Math.max(0, w.search(/Cuadro|Frame|Rahmen/) + Math.max(0, m.index - 2500) - 50); }
  return -1;
}
let ultimoErrorIA = '', modeloIAok = '', modeloIAelegido = '';
// Llama a Gemini probando modelos: el que funcionó la última vez, el configurado, los conocidos y el que sugiera Google
// en su mensaje de error («use models/gemini-x.y-flash»). Devuelve el texto, o '' y deja el motivo en ultimoErrorIA.
// Modelos de Gemini que la clave puede usar (lista oficial de Google), los «flash» más nuevos primero. Se refresca cada 6 h.
let modelosIA = { t: 0, lista: [], todos: [] }, pruebasIA = null;
async function modelosDisponibles(key) {
  if (Date.now() - modelosIA.t < 6 * 3600e3 && modelosIA.lista.length) return modelosIA.lista;
  try {
    const j = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(key)}`).then(r => r.json());
    const ver = n => (String(n).match(/(\d+(?:\.\d+)?)/) || [0, 0])[1] * 1;
    // todos: cualquier Gemini que genere texto (para elegir a mano); lista: los estables, para el modo automático
    const orden = (a, b) => (/flash/.test(b.id) - /flash/.test(a.id)) || (/lite/.test(a.id) - /lite/.test(b.id)) || ver(b.id) - ver(a.id);
    const todos = (j.models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent') && /gemini/i.test(m.name) && !/embedding|tts|image-gen|audio|live/i.test(m.name))
      .map(m => ({ id: m.name.replace(/^models\//, ''), nombre: m.displayName || m.name })).sort(orden);
    const lista = todos.filter(m => !/thinking-exp|exp-|preview|image|vision/i.test(m.id));
    if (todos.length) modelosIA = { t: Date.now(), lista, todos };
  } catch (e) {}
  return modelosIA.lista;
}
// Prueba un solo modelo (sin pasar a otros): para que el usuario vea cuáles funcionan con su clave
async function probarModelo(key, mdl) {
  const t0 = Date.now();
  try {
    const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 20000);
    const g = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${mdl}:generateContent?key=${encodeURIComponent(key)}`, { method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: 'Responde solo este JSON: {"ok": true}' }] }], generationConfig: { temperature: 0, response_mime_type: 'application/json' } }) });
    clearTimeout(to);
    const j = await g.json().catch(() => ({}));
    if (!g.ok || j.error) { const msg = String((j.error && j.error.message) || 'HTTP ' + g.status);
      return { id: mdl, ok: false, error: g.status === 429 || /exhausted|quota/i.test(msg) ? 'cuota agotada o límite por minuto' : g.status === 503 || /overload|high demand/i.test(msg) ? 'saturado ahora' : /no longer available|not found|not supported/i.test(msg) ? 'no disponible para tu clave' : msg.split('.')[0].slice(0, 80) }; }
    return { id: mdl, ok: true, ms: Date.now() - t0 };
  } catch (e) { return { id: mdl, ok: false, error: e.name === 'AbortError' ? 'tardó demasiado' : e.message }; }
}
// Llama a Gemini probando modelos: el elegido en el panel, el que funcionó la última vez, los de la lista de Google
// y el que sugiera Google en su mensaje de error. Devuelve el texto, o '' y deja en ultimoErrorIA el motivo de cada intento.
async function llamarGemini(prompt, temperatura = 0.2, espera = 40000) {
  const key = process.env.GEMINI_API_KEY; if (!key) { ultimoErrorIA = 'Falta GEMINI_API_KEY'; return ''; }
  const limpio = m => String(m || '').replace(/^models\//, '').replace(/[^a-zA-Z0-9.\-]/g, '');
  const lista = (await modelosDisponibles(key)).map(m => m.id);
  const cola = [modeloIAelegido, modeloIAok, process.env.BIKES_GEMINI_MODEL, ...lista.slice(0, 6), 'gemini-3.8-flash', 'gemini-3.6-flash'].map(limpio).filter(Boolean);
  const probados = new Set(), reintentos = {}, errores = [];
  ultimoErrorIA = '';
  while (cola.length && probados.size < 8) {
    const mdl = cola.shift(); if (probados.has(mdl)) continue; probados.add(mdl);
    try {
      const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), espera);
      const g = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${mdl}:generateContent?key=${encodeURIComponent(key)}`, { method: 'POST', signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: temperatura, response_mime_type: 'application/json' } }) });
      clearTimeout(to);
      const j = await g.json().catch(() => ({}));
      if (!g.ok || j.error) {
        const msg = (j.error && j.error.message) || 'HTTP ' + g.status;
        // Saturado (429/503/«overloaded»): espera y reintenta el mismo modelo hasta 2 veces antes de pasar a otro
        if ((g.status === 429 || g.status === 503 || /overload|exhausted|try again|high demand/i.test(msg)) && (reintentos[mdl] || 0) < 2) {
          reintentos[mdl] = (reintentos[mdl] || 0) + 1; probados.delete(mdl); cola.unshift(mdl);
          await new Promise(r => setTimeout(r, reintentos[mdl] * 3000)); continue;
        }
        errores.push(`${mdl}: ${String(msg).split('.')[0].slice(0, 90)}`);
        for (const m of String(msg).matchAll(/models\/([a-z0-9.\-]+)/gi)) if (!probados.has(limpio(m[1]))) cola.unshift(limpio(m[1])); // el que recomienda Google
        continue;
      }
      const txt = (((j.candidates || [])[0] || {}).content || {}).parts?.map(x => x.text).join('') || '';
      if (txt) { modeloIAok = mdl; ultimoErrorIA = ''; return txt; }
      errores.push(`${mdl}: respuesta vacía`);
    } catch (e) { errores.push(`${mdl}: ${e.name === 'AbortError' ? 'tardó demasiado' : e.message}`.slice(0, 120)); }
  }
  ultimoErrorIA = ('IA sin respuesta · ' + errores.join(' · ')).slice(0, 600);
  return '';
}
async function fichaIA(texto, nombre) {
  const key = process.env.GEMINI_API_KEY; if (!key) return null;
  const i = inicioSpecs(texto);
  const trozo = i >= 0 ? texto.slice(Math.max(0, i - 2500), i + 9000) : texto.slice(Math.min(3000, texto.length / 4), Math.min(3000, texto.length / 4) + 11000);
  const prompt = `Eres redactor de una tienda de bicicletas en Perú. Con el texto de la página oficial de la bicicleta «${nombre}», responde SOLO JSON:
{"descripcion": "2 a 3 frases en español neutro, para vender, sin inventar nada que no esté en el texto",
 "categoria": "Downhill|Bike Park|Enduro|Trail|XC|Gravel|E-MTB|Dirt|Kids|Ruta u otra breve",
 "recorrido": "ej. 165/170 mm o vacío", "rec_del": 170, "rec_tras": 165, "material": "Carbono, Aluminio o Carbono/Aluminio", "aro": "29, 27.5 o Mullet (si usa 29 adelante y 27.5 atrás)",
 "motor": "solo e-bikes, ej. Bosch CX Gen5 · 800 Wh", "peso": "ej. 23.5 kg o vacío",
 "specs": [{"k": "Cuadro", "v": "valor resumido (máx. 120 caracteres)"}],
 "tallas": [{"t": "M", "min": 170, "max": 180}],
 "garantia": "solo si el texto la menciona, ej. Cuadro: 5 años · Componentes: 2 años; si no, vacío"}
En "tallas" pon la altura recomendada del ciclista en cm por talla SOLO si el texto trae esa tabla; si no, [].
En "specs" pon hasta 18 filas en español (Cuadro, Horquilla, Amortiguador, Motor, Batería, Transmisión, Frenos, Ruedas, Neumáticos, Tija, Tallas…), con valores resumidos.
TEXTO:
${trozo}`;
  ultimoErrorIA = '';
  const txt = await llamarGemini(prompt, 0.2, 40000);
  if (!txt) { console.warn('[bikes] ficha IA', ultimoErrorIA); return null; }
  try {
    const o = JSON.parse(txt);
    const corto = (v, n) => String(v || '').trim().slice(0, n);
    return { descripcion: corto(o.descripcion, 900), categoria: corto(o.categoria, 40), recorrido: corto(o.recorrido, 40), material: corto(o.material, 60), aro: corto(o.aro, 20),
      motor: corto(o.motor, 120), peso: corto(o.peso, 20), specs: (Array.isArray(o.specs) ? o.specs : []).slice(0, 20).map(x => ({ k: corto(x.k, 40), v: corto(x.v, 160) })).filter(x => x.k && x.v),
      rec_del: Math.round(num(o.rec_del)) || 0, rec_tras: Math.round(num(o.rec_tras)) || 0,
      tallas: (Array.isArray(o.tallas) ? o.tallas : []).slice(0, 10).map(x => ({ t: corto(x.t, 10), min: Math.round(num(x.min)), max: Math.round(num(x.max)) })).filter(x => x.t && x.min > 100 && x.max > x.min && x.max < 230),
      garantia: corto(o.garantia, 200) };
  } catch (e) { console.warn('[bikes] ficha IA', e.message); return null; }
}
// Lee una o varias páginas de la marca (separadas por espacio, coma o salto) y junta sus links de modelos.
// Si no encuentra ninguno, explica qué recibió el servidor (bloqueo, redirección, página vacía).
async function linksDeVarias(urls) {
  const lista = String(urls || '').split(/[\s,]+/).filter(u => /^https?:\/\//i.test(u)).slice(0, 5);
  if (!lista.length) throw new Error('Pega un link de la marca');
  const todos = [], vistos = new Set(), diag = [];
  for (const url of lista) {
    try {
      const pag = await leerFicha(url, { soloHtml: true });
      const ls = linksDeModelos(pag.html, pag.url);
      for (const l of ls) if (!vistos.has(l.slug)) { vistos.add(l.slug); todos.push(l); }
      if (pag.url !== url) diag.push(`${url} redirigió a ${pag.url}`);
      if (!ls.length) diag.push(`${url} → ${pag.url !== url ? 'redirigió a ' + pag.url + ', ' : ''}${Math.round(pag.html.length / 1024)} KB, título «${((pag.html.match(/<title[^>]*>([^<]*)/i) || [])[1] || '').trim().slice(0, 80)}»`);
    } catch (e) { diag.push(`${url} → ${e.message}`); }
  }
  return { links: todos, diag };
}
// Links de modelos en una página de la marca (mismo dominio e idioma), para la carga masiva
function linksDeModelos(html, base) {
  // href y también data-url / data-href (ej. el histórico de temporadas de Mondraker)
  return filtrarLinks([...html.matchAll(/(?:href|data-url|data-href)=["']([^"'#?]+)["']/gi)].map(m => decodificar(m[1])), base);
}
function filtrarLinks(urls, base) {
  const b = new URL(base); const pref = b.pathname.split('/').filter(Boolean).slice(0, 2).join('/');
  const out = new Map();
  for (const x of urls) {
    let u; try { u = new URL(String(x).split('#')[0].split('?')[0], b); } catch (e) { continue; }
    if (u.hostname !== b.hostname) continue;
    const partes = u.pathname.split('/').filter(Boolean);
    if (partes.length < 1 || (pref && !u.pathname.slice(1).startsWith(pref))) continue;
    const sl = partes[partes.length - 1].toLowerCase();
    if (!/[a-z]/.test(sl) || sl.length < 3 || /\.(jpe?g|png|pdf|css|js)$/.test(sl)) continue;
    const det = h => /season-history\/detail|\/detail\//.test(h);
    if (!out.has(sl) || (!det(out.get(sl)) && det(u.href))) out.set(sl, u.href); // mejor la ficha de temporada que la del menú
  }
  // Primero las fichas de temporada (season-history/detail), que traen fotos grandes y especificaciones
  return [...out.entries()].map(([slug, url]) => ({ slug, url })).sort((a, c) => (/season-history\/detail|\/detail\//.test(c.url) ? 1 : 0) - (/season-history\/detail|\/detail\//.test(a.url) ? 1 : 0));
}
const IGNORAR_TOK = new Set(['mx', 'mullet', '29', '275', '27', '5', '2025', '2026', '2027', 'my26', 'my27']);
// Tokens de un nombre o slug; quita códigos pegados al final (ej. "foxy-carbon-rr68f09832861fb" → foxy carbon rr)
const VERSION_TOK = new Set(['s', 'r', 'rr', 'x', 'xr', 'rx', 'rs', 'sl', 'lt', 'e', 'flat', 'unlimited', 'axs', 'grx', 'team', 'pro', 'comp', 'race']);
const tokensDe = t => slug(t).replace(/(.)[0-9a-f]{13}$/, '$1').replace(/^(.*?[a-z])(?:[0-9a-f]{8,}|\d{6,})$/, '$1').split('-').filter(x => x && !IGNORAR_TOK.has(x));
// Empareja cada modelo del catálogo con el link más parecido: uno debe contener todas las palabras del otro
// (ej. "SUMMUM R MX" ↔ summum-r-quasar-blue), gana el de mayor parecido.
function emparejarModelos(modelos, links) {
  const out = {};
  for (const mo of modelos) {
    const mt = tokensDe(mo); if (!mt.length) continue; const ms = new Set(mt); let best = null, bs = 0;
    for (const l of links) {
      const lt = tokensDe(l.slug); if (!lt.length) continue; const ls = new Set(lt);
      if (!(lt.every(t => ms.has(t)) || mt.every(t => ls.has(t)))) continue;
      // Las palabras que distinguen versiones no pueden sobrar: ZENDIT S ≠ zendit-rr-s, ZENDIT LT RR ≠ zendit-rr, KAOZ ≠ kaoz-frameset
      if (lt.some(t => !ms.has(t) && (VERSION_TOK.has(t) || t === 'frameset' || /^\d+$/.test(t))) || mt.some(t => !ls.has(t) && (VERSION_TOK.has(t) || t === 'frameset' || /^\d+$/.test(t)))) continue;
      const inter = mt.filter(t => ls.has(t)).length, union = new Set([...mt, ...lt]).size, sc = inter / union;
      const minimo = mt.every(t => ls.has(t)) ? 0.3 : 0.5; // si el link contiene todo el nombre del modelo, basta menos parecido
      if (inter >= Math.min(2, mt.length) && sc >= minimo && sc > bs) { bs = sc; best = l; }
    }
    if (best) out[mo] = best.url;
  }
  return out;
}

async function leerFicha(url, opciones = {}) {
  let u; try { u = new URL(url); } catch (e) { throw new Error('El link no es válido'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Solo links http(s)');
  const ips = await dnsP.lookup(u.hostname, { all: true }).catch(() => []);
  if (!ips.length || ips.some(x => ipPrivada(x.address))) throw new Error('No se pudo abrir ese dominio');
  const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 15000);
  const r = await fetch(u.href, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36', 'Accept-Language': 'es,en;q=0.8' } });
  clearTimeout(to);
  if (!r.ok) throw new Error(`La página respondió ${r.status}`);
  const html = (await r.text()).slice(0, 4e6);
  if (opciones.soloHtml) return { html, url: r.url || u.href };
  const f = leerFichaHtml(html, r.url || u.href);
  return { ...(await completarFicha(f, htmlATexto(html), opciones)), url: u.href };
}
// Ficha leída en el navegador del usuario (lector): fotos y texto ya extraídos allá
const EXCLUIR_IMG = /\.svg(\?|$)|logo|share|icon|sprite|favicon|placeholder|blank|pixel|badge|flag|payment|[-_]geo[-_.]|geometr|size-?guide|sizing/i;
async function fichaDesdeNavegador(url, imgs, texto, nombre) {
  const todas = (Array.isArray(imgs) ? imgs : []).map(String).filter(u => /^https?:\/\//i.test(u));
  const lista = [...new Set(todas.filter(u => !EXCLUIR_IMG.test(u)))].slice(0, 400);
  const f = { titulo: nombre, descripcion: '', imagenes: elegirImagenes(lista, url).slice(0, 16), geo: fotoGeometria(todas) };
  return { ...(await completarFicha(f, String(texto || '').slice(0, 200000), { nombre })), url };
}
// Tabla de geometría a partir del texto de la ficha (filas A, B, C… con un valor por talla, en mm o grados)
const RE_TALLA_GEO = /^(XXS|XS|S|S\/M|SM|M|M\/L|ML|L|L\/XL|LXL|XL|XXL|S[1-6]|[1-6]|\d{2}(?:\.\d)?|One size|Única|Unica)$/i;
function geometriaDeTexto(texto) {
  const t = String(texto || ''); const i = t.search(/\n\s*(Frame size|Talla(?: de cuadro)?|Size)\s*\n/i);
  if (i < 0) return null;
  const L = t.slice(i, i + 20000).split('\n').map(x => x.trim()).filter(x => x && x !== '&nbsp;').slice(1);
  let k = 0; const tallas = [];
  while (k < L.length && RE_TALLA_GEO.test(L[k])) tallas.push(L[k++].toUpperCase().replace('ML', 'M/L'));
  if (!tallas.length && L[0] && /^[A-Z]{1,2}$/.test(L[1] || '')) { tallas.push('Única'); k = 1; } // talla única (ej. F-Trick 26)
  if (!tallas.length) return null;
  // Algunas marcas repiten las tallas para dos configuraciones (ej. vainas estándar y cortas): se usa la primera
  let n = tallas.length; if (n % 2 === 0 && tallas.slice(0, n / 2).join() === tallas.slice(n / 2).join()) n = n / 2;
  const esValor = x => /^[-–]?\s?\d+(?:[.,]\d+)?\s?(mm|°|º)?$/i.test(x), esPulg = x => /^[-–]?\s?\d+(?:[.,]\d+)?\s?("|”|in)$/i.test(x);
  const filas = [];
  while (k < L.length && filas.length < 30) {
    let letra = '';
    if (/^[A-Z]{1,2}$/.test(L[k])) letra = L[k++];
    const nombre = L[k];
    if (!nombre || esValor(nombre) || nombre.length > 60) break;
    k++;
    const vals = [];
    while (k < L.length && (esValor(L[k]) || esPulg(L[k]))) { if (esValor(L[k])) vals.push(L[k].replace(/^([-–])\s+/, '-').replace(/\s+/g, ' ')); k++; }
    if (vals.length < n) break;
    filas.push({ l: letra, n: nombre.slice(0, 50), v: vals.slice(0, n) });
  }
  // Valores sin unidad: si la fila no es de ángulo, son milímetros
  for (const f of filas) f.v = f.v.map(v => /mm|°|º/.test(v) ? v : v + (/[áa]ngulo|angle/i.test(f.n) ? '°' : ' mm'));
  return filas.length >= 3 ? { tallas: tallas.slice(0, n), filas } : null;
}
// Dibujo de geometría de la marca (la foto con «geo»/«geometry» en el nombre, la más grande)
function fotoGeometria(imgs) {
  const g = imgs.filter(u => /[-_]geo[-_.]|geometr/i.test(u) && !/\.svg/i.test(u));
  const t = u => +((u.match(/[-_/](\d{3,4})_/) || [])[1] || 800);
  return g.sort((a, b) => t(b) - t(a))[0] || null;
}
async function completarFicha(f, texto, opciones = {}) {
  const ia = opciones.ia === false ? null : await fichaIA(texto, opciones.nombre || f.titulo);
  if (ia) { f.ia = true; if (ia.descripcion) f.descripcion = ia.descripcion; f.specs = ia.specs; f.datos = { categoria: ia.categoria, recorrido: ia.recorrido, material: ia.material, aro: ia.aro, motor: ia.motor, peso: ia.peso, tallas: ia.tallas, garantia: ia.garantia, rec_del: ia.rec_del, rec_tras: ia.rec_tras }; }
  else { f.specs = specsSimples(texto); if (ultimoErrorIA) f.ia_error = ultimoErrorIA;
    const peso = (f.specs.find(x => /^peso|weight/i.test(x.k)) || {}).v; if (peso) f.datos = { peso: peso.slice(0, 20) }; }
  if (!f.descripcion && f.specs && f.specs.length) f.descripcion = descDeSpecs(opciones.nombre || f.titulo, f.specs);
  const geometria = geometriaDeTexto(texto);
  f.datos = { ...datosDeSpecs(f.specs || []), ...Object.fromEntries(Object.entries(f.datos || {}).filter(([, x]) => x)), ...(f.geo ? { geo: f.geo } : {}), ...(geometria ? { geometria } : {}) };
  if (!f.imagenes.length && !f.descripcion) throw new Error('No encontré fotos ni descripción en esa página. Si la marca bloquea al servidor, usa el «Lector desde tu navegador».');
  return f;
}

// ── Registro de rutas ─────────────────────────────────────────────────────────
module.exports = function registrarBikes({ app, authAdmin, requiereModulo, portalPool }) {
  // sendBeacon manda text/plain; express.json global no lo lee
  const express_text_o_json = require('express').text({ type: ['text/plain', 'application/json'], limit: '20kb' });
  const mBikes = requiereModulo('bikes');
  const usuarioDe = req => (req.admin && req.admin.usuario) || 'admin';

  let _listo = null;
  function prepararTablas() {
    if (_listo) return _listo;
    _listo = (async () => {
      await portalPool.query(`
        CREATE TABLE IF NOT EXISTS bk_skus (
          id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
          marca VARCHAR(60) NOT NULL, modelo VARCHAR(120) NOT NULL, montaje VARCHAR(80) NOT NULL DEFAULT 'Base',
          anio SMALLINT NULL, categoria VARCHAR(40) NULL, aro VARCHAR(20) NULL, recorrido VARCHAR(40) NULL,
          material VARCHAR(60) NULL, motor VARCHAR(120) NULL, talla VARCHAR(10) NOT NULL, color VARCHAR(80) NOT NULL,
          color_hex VARCHAR(9) NULL, sku VARCHAR(80) NULL, costo DECIMAL(12,2) NOT NULL, moneda CHAR(3) NOT NULL DEFAULT 'USD',
          pvp DECIMAL(12,2) NULL, stock INT NOT NULL DEFAULT 0, reservado INT NOT NULL DEFAULT 0,
          estado VARCHAR(20) NOT NULL DEFAULT 'A pedido', fecha_disponible DATE NULL, peso VARCHAR(20) NULL,
          url_imagen VARCHAR(500) NULL, url_ficha VARCHAR(500) NULL, notas VARCHAR(500) NULL,
          activo TINYINT(1) NOT NULL DEFAULT 1, import_id INT UNSIGNED NULL,
          creado DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, actualizado DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          KEY (marca, modelo), KEY (activo)
        ) DEFAULT CHARSET=utf8mb4`);
      await portalPool.query(`CREATE TABLE IF NOT EXISTS bk_config (clave VARCHAR(40) PRIMARY KEY, valor MEDIUMTEXT NOT NULL,
          actualizado DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, actualizado_por VARCHAR(80) NULL) DEFAULT CHARSET=utf8mb4`);
      await portalPool.query(`
        CREATE TABLE IF NOT EXISTS bk_reservas (
          id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, codigo VARCHAR(12) NOT NULL UNIQUE,
          creado DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, sku_id INT UNSIGNED NOT NULL,
          marca VARCHAR(60) NOT NULL, modelo VARCHAR(120) NOT NULL, montaje VARCHAR(80) NOT NULL, talla VARCHAR(10) NOT NULL, color VARCHAR(80) NOT NULL,
          sku VARCHAR(80) NULL, envio VARCHAR(12) NOT NULL, extras MEDIUMTEXT NULL,
          precio_bici DECIMAL(12,2) NOT NULL, extras_total DECIMAL(12,2) NOT NULL DEFAULT 0, total DECIMAL(12,2) NOT NULL, adelanto DECIMAL(12,2) NOT NULL,
          tc_usd DECIMAL(8,4) NOT NULL, costo_usd DECIMAL(12,2) NULL, valido_hasta DATETIME NULL,
          fecha_min DATE NULL, fecha_max DATE NULL,
          nombre VARCHAR(120) NOT NULL, doc VARCHAR(11) NOT NULL, tel VARCHAR(15) NOT NULL, email VARCHAR(120) NULL, ciudad VARCHAR(60) NULL,
          ref VARCHAR(60) NULL, estado VARCHAR(30) NOT NULL DEFAULT 'Nueva', nota_interna TEXT NULL, venta_erp VARCHAR(40) NULL,
          ip VARCHAR(45) NULL, actualizado DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, actualizado_por VARCHAR(80) NULL,
          KEY (estado), KEY (doc)
        ) DEFAULT CHARSET=utf8mb4`);
      await portalPool.query(`CREATE TABLE IF NOT EXISTS bk_imports (id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
          creado DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, usuario VARCHAR(80) NULL, archivo VARCHAR(200) NULL,
          marcas VARCHAR(300) NULL, modo VARCHAR(20) NULL, nuevas INT NOT NULL DEFAULT 0, actualizadas INT NOT NULL DEFAULT 0, desactivadas INT NOT NULL DEFAULT 0) DEFAULT CHARSET=utf8mb4`);
      // Datos por modelo: fotos y descripción traídas del link de la marca, y ajustes de envío
      await portalPool.query(`CREATE TABLE IF NOT EXISTS bk_modelos (marca VARCHAR(60) NOT NULL, modelo VARCHAR(120) NOT NULL,
          descripcion TEXT NULL, imagenes MEDIUMTEXT NULL, url_ficha VARCHAR(500) NULL, aereo VARCHAR(5) NOT NULL DEFAULT 'auto', unidad VARCHAR(5) NOT NULL DEFAULT 'auto',
          specs MEDIUMTEXT NULL, datos TEXT NULL, manual TINYINT(1) NOT NULL DEFAULT 0,
          actualizado DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (marca, modelo)) DEFAULT CHARSET=utf8mb4`);
      for (const col of ['specs MEDIUMTEXT NULL', 'datos TEXT NULL', 'manual TINYINT(1) NOT NULL DEFAULT 0', 'img_colores MEDIUMTEXT NULL', 'confirmado TINYINT(1) NOT NULL DEFAULT 0', 'destacado TINYINT(1) NOT NULL DEFAULT 0', "etiqueta VARCHAR(15) NOT NULL DEFAULT ''"])
        await portalPool.query(`ALTER TABLE bk_modelos ADD COLUMN ${col}`).catch(() => {}); // ya existe
      await portalPool.query(`ALTER TABLE bk_reservas ADD COLUMN pago VARCHAR(4) NULL`).catch(() => {});
      await portalPool.query(`ALTER TABLE bk_skus ADD COLUMN stock_kuranko INT NOT NULL DEFAULT 0`).catch(() => {});
      try { const [[ia]] = await portalPool.query(`SELECT valor FROM bk_config WHERE clave='ia'`); if (ia) modeloIAelegido = (JSON.parse(ia.valor) || {}).modelo || ''; } catch (e) {}
      await portalPool.query(`CREATE TABLE IF NOT EXISTS bk_llamadas (id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, creado DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          nombre VARCHAR(120) NOT NULL, tel VARCHAR(15) NOT NULL, fecha DATE NULL, franja VARCHAR(30) NULL, tema VARCHAR(300) NULL, ref VARCHAR(60) NULL,
          estado VARCHAR(20) NOT NULL DEFAULT 'Pendiente', nota TEXT NULL, ip VARCHAR(45) NULL) DEFAULT CHARSET=utf8mb4`);
      // Métricas propias: clics y embudo (visita → modelo → configura → carrito → reserva)
      await portalPool.query(`CREATE TABLE IF NOT EXISTS bk_eventos (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
          creado DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, sesion VARCHAR(24) NOT NULL, tipo VARCHAR(16) NOT NULL,
          marca VARCHAR(60) NULL, modelo VARCHAR(120) NULL, sku_id INT UNSIGNED NULL, valor DECIMAL(12,2) NULL,
          ref VARCHAR(60) NULL, origen VARCHAR(120) NULL, movil TINYINT(1) NULL,
          KEY (creado), KEY (tipo, creado)) DEFAULT CHARSET=utf8mb4`);
    })().catch(e => { _listo = null; throw e; });
    return _listo;
  }

  async function leerReglas() {
    await prepararTablas();
    const [[row]] = await portalPool.query(`SELECT valor FROM bk_config WHERE clave='reglas'`);
    let g = null; try { g = row ? JSON.parse(row.valor) : null; } catch (e) { g = null; }
    return mezclarReglas(g);
  }
  const COLS = `id, marca, modelo, montaje, anio, categoria, aro, recorrido, material, motor, talla, color, color_hex, sku,
    costo, moneda, pvp, stock, reservado, stock_kuranko, estado, DATE_FORMAT(fecha_disponible,'%Y-%m-%d') AS fecha_disponible, peso, url_imagen, url_ficha, notas, activo,
    DATE_FORMAT(actualizado,'%Y-%m-%d %H:%i') AS actualizado`;
  async function leerSkus(soloActivos = true) {
    await prepararTablas();
    const [rows] = await portalPool.query(`SELECT ${COLS} FROM bk_skus ${soloActivos ? 'WHERE activo=1' : ''} ORDER BY marca, modelo, montaje, id`);
    return rows.map(r => ({ ...r, costo: num(r.costo), pvp: r.pvp == null ? null : num(r.pvp) }));
  }

  async function leerModelos() {
    await prepararTablas();
    const [rows] = await portalPool.query('SELECT marca, modelo, descripcion, imagenes, img_colores, confirmado, destacado, etiqueta, url_ficha, aereo, unidad, specs, datos, manual FROM bk_modelos');
    const out = {}, js = (t, d) => { try { return JSON.parse(t || '') ?? d; } catch (e) { return d; } };
    for (const r of rows) out[r.marca + '|' + r.modelo] = { desc: r.descripcion || '', imgs: js(r.imagenes, []), url_ficha: r.url_ficha || null, aereo: r.aereo, unidad: r.unidad,
      specs: js(r.specs, []), datos: js(r.datos, {}), manual: !!r.manual, imgc: js(r.img_colores, {}), confirmado: !!r.confirmado, destacado: !!r.destacado, etiqueta: r.etiqueta || '' };
    // Framesets: si la marca no publica sus especificaciones o su geometría (ej. Anark XR Frameset), se toman las del
    // cuadro de la bici completa del mismo modelo (cuadro, tallas, amortiguador, dirección…), solo para lo que falte
    try {
      const [fs] = await portalPool.query(`SELECT DISTINCT marca, modelo FROM bk_skus WHERE activo=1 AND (modelo LIKE '%frameset%' OR modelo LIKE '%cuadro%')`);
      const DEL_CUADRO = /^(cuadro|frame|tallas?|sizes?|amortiguador|shock|ajuste del amortiguador|direcci[oó]n|headset|eje|pedalier|bottom bracket|tija|abrazadera|peso)/i;
      for (const f of fs) {
        const k = f.marca + '|' + f.modelo; const md = out[k] || (out[k] = { desc: '', imgs: [], specs: [], datos: {}, imgc: {} });
        if ((md.specs || []).length && (md.datos || {}).geometria) continue;
        const sin = tokensDe(f.modelo).filter(t => !['frameset', 'cuadro', 'frame'].includes(t)).join(' ');
        const base = Object.keys(out).find(x => x.startsWith(f.marca + '|') && x !== k && !/frameset|cuadro/i.test(x) && tokensDe(x.split('|')[1]).join(' ') === sin && ((out[x].specs || []).length || (out[x].datos || {}).geometria));
        if (!base) continue;
        const b = out[base];
        if (!(md.specs || []).length) md.specs = (b.specs || []).filter(x => DEL_CUADRO.test(x.k));
        md.datos = { ...(md.datos || {}) };
        for (const c of ['geometria', 'geo', 'rec_tras', 'material', 'aro', 'tallas']) if (!md.datos[c] && (b.datos || {})[c]) md.datos[c] = b.datos[c];
        md.heredado = base.split('|')[1];
      }
    } catch (e) { console.warn('[bikes] framesets', e.message); }
    return out;
  }
  // Envíos en grupo (e-bikes): reservas activas con envío "grupo", por marca
  async function gruposPorMarca(R, conn = portalPool) {
    const [rows] = await conn.query(`SELECT marca, COUNT(*) n FROM bk_reservas WHERE envio='grupo' AND estado NOT IN ('Cancelada','Entregada') GROUP BY marca`);
    const min = Math.max(2, num(R.grupo_min) || 3), out = {};
    for (const r of rows) out[r.marca] = { min, actual: r.n % min, completos: Math.floor(r.n / min) };
    return out;
  }

  // Caché corta del catálogo público (se limpia al importar o cambiar reglas)
  let catCache = null;
  const limpiarCache = () => { catCache = null; };

  // ── PÚBLICO ─────────────────────────────────────────────────────────────────
  // ── Cabecera de kuranko.pe (menú y archivos) ───────────────────────────────
  app.get('/api/bikes/cabecera', async (req, res) => {
    const c = await cabeceraKuranko();
    res.set('Cache-Control', 'public, max-age=600');
    res.json({ menu: c.menu, fuente: c.fuente });
  });
  app.get('/bikes-assets/:archivo', async (req, res) => {
    const a = ACTIVOS[req.params.archivo];
    if (!a) return res.status(404).end();
    try {
      let x = activosCache.get(req.params.archivo);
      if (!x || Date.now() - x.t > 24 * 3600e3) {
        const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 15000);
        const r = await fetch(K + a[0], { signal: ctrl.signal }); clearTimeout(to);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        x = { buf: Buffer.from(await r.arrayBuffer()), t: Date.now() };
        activosCache.set(req.params.archivo, x);
      }
      res.set({ 'Content-Type': a[1], 'Cache-Control': 'public, max-age=604800', 'Access-Control-Allow-Origin': '*' });
      res.send(x.buf);
    } catch (e) { console.warn('[bikes] activo', req.params.archivo, e.message); res.redirect(302, K + a[0]); }
  });

  async function catalogoPublico() {
      if (!catCache || Date.now() - catCache.t > 60000) {
        const R = await leerReglas(); const tc = await tcEfectivo(R);
        const infoMarcas = await leerMarcas();
        let skus = (await leerSkus(true)).filter(s => (infoMarcas[s.marca] || {}).visible !== false);
        const mods = await leerModelos();
        if (R.solo_completos !== false) {
          const porMod = {}; skus.forEach(s => (porMod[s.marca + '|' + s.modelo] ||= []).push(s));
          skus = skus.filter(s => !fichaCompleta(mods[s.marca + '|' + s.modelo], porMod[s.marca + '|' + s.modelo]).length);
        }
        catCache = { t: Date.now(), data: {
          modelos: armarCatalogo(skus, R, tc, hoyLima(), mods),
          cuotas: R.cuotas || {}, cuotas_bancos: R.cuotas_bancos || '', franjas: FRANJAS,
          grupos: await gruposPorMarca(R), grupo_min: Math.max(2, num(R.grupo_min) || 3),
          pagina: await (async () => { const pg = await leerPagina(); const f = pg.fotos || {};
            return { asesor_nombre: pg.asesor_nombre || 'Jean Pierre', asesor_cargo: pg.asesor_cargo || 'Asesor de bicicletas', asesor_whatsapp: (pg.asesor_whatsapp || '').replace(/\D/g, '') || null,
              soporte_url: pg.soporte_url || null, soporte_texto: pg.soporte_texto || null,
              fotos: Object.fromEntries(CLAVES_FOTO.map(k => [k, f[k] ? `/api/bikes/foto/${k}?v=${f[k]}` : null])) }; })(),
          logos: Object.fromEntries(Object.entries(await leerMarcas()).filter(([, v]) => v && v.logo).map(([k, v]) => [k, v.logo])),
          marcas: [...new Set([...MARCAS_BASE, ...skus.map(s => s.marca)])].filter(m => skus.some(s => s.marca === m)),
          moneda: R.moneda_principal, garantias: Object.fromEntries(Object.entries(infoMarcas).filter(([, v]) => v && v.garantia).map(([k, v]) => [k, v.garantia])),
          adelanto: num(R.adelanto), tc_usd: tc.usd, aereo: !!R.aereo_activo, validez_horas: num(R.validez_horas),
          extras: (R.extras || []).map(e => ({ id: e.id, nombre: e.nombre, precio: num(e.precio), incluido: !!e.incluido })),
          whatsapp: process.env.BIKES_WHATSAPP || '51963358335', hoy: hoyLima(),
          ga: (process.env.BIKES_GA_ID || '').replace(/[^\w-]/g, '') || null, pixel: (process.env.BIKES_META_PIXEL || '').replace(/\D/g, '') || null,
          actualizado: skus.reduce((a, s) => s.actualizado > a ? s.actualizado : a, '')
        } };
      }
      return catCache.data;
  }
  app.get('/api/bikes/catalogo', async (req, res) => {
    try {
      const data = await catalogoPublico();
      res.set('Cache-Control', 'public, max-age=30');
      res.json(data);
    } catch (e) { console.error('[bikes] catalogo', e.message); res.status(500).json({ error: 'No se pudo cargar el catálogo. Intenta en un momento.' }); }
  });

  // Límite simple anti-spam por IP (en memoria)
  const intentos = new Map();
  function demasiados(clave, max = 6) {
    const ahora = Date.now(), lista = (intentos.get(clave) || []).filter(t => ahora - t < 3600e3);
    lista.push(ahora); intentos.set(clave, lista);
    if (intentos.size > 5000) intentos.clear();
    return lista.length > max;
  }
  const ipDe = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim().slice(0, 45);

  async function nuevoCodigo(conn) {
    for (let i = 0; i < 8; i++) {
      const c = 'KB-' + Math.random().toString(36).slice(2, 8).toUpperCase().padEnd(6, '7');
      const [[x]] = await conn.query('SELECT id FROM bk_reservas WHERE codigo=?', [c]);
      if (!x) return c;
    }
    throw new Error('no se pudo generar código');
  }

  async function enviarCorreo(para, asunto, html, texto) {
    const key = process.env.RESEND_API_KEY;
    if (!key || !para || !para.length) return { correo: false };
    try {
      const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 10000);
      const r = await fetch('https://api.resend.com/emails', { method: 'POST', signal: ctrl.signal,
        headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: process.env.RESEND_FROM || 'Kuranko Bikes <noreply@kuranko.pe>', to: para, subject: asunto, html, text: texto }) });
      clearTimeout(to);
      return { correo: r.ok };
    } catch (e) { console.warn('[bikes] correo', e.message); return { correo: false }; }
  }
  const fechaCorta = iso => iso ? new Date(iso + 'T12:00:00Z').toLocaleDateString('es-PE', { day: 'numeric', month: 'short', timeZone: 'UTC' }).replace('.', '') : '';

  app.post('/api/bikes/reservar', async (req, res) => {
    const b = req.body || {};
    if (b.web) return res.json({ ok: true, codigo: 'KB-000000' }); // campo trampa (bots)
    const ip = ipDe(req);
    // Hasta 20 intentos y 4 reservas guardadas por hora desde la misma conexión
    const yaHechas = (intentos.get('ok:' + ip) || []).filter(t => Date.now() - t < 3600e3).length;
    if (demasiados('try:' + ip, 20) || yaHechas >= 4) return res.status(429).json({ error: 'Hiciste varias reservas seguidas. Escríbenos por WhatsApp y te ayudamos.' });
    const nombre = String(b.nombre || '').trim().replace(/\s+/g, ' ').slice(0, 120);
    const doc = String(b.doc || '').replace(/\D/g, '');
    let tel = String(b.tel || '').replace(/\D/g, ''); if (tel.length === 11 && tel.startsWith('51')) tel = tel.slice(2);
    const email = String(b.email || '').trim().slice(0, 120);
    const ciudad = String(b.ciudad || 'Lima').trim().slice(0, 60);
    const ref = String(b.ref || '').trim().replace(/[^\w.\-]/g, '').slice(0, 60) || null;
    const err = [];
    if (nombre.length < 3) err.push('escribe tu nombre completo');
    if (!/^(\d{8}|\d{11})$/.test(doc)) err.push('el DNI tiene 8 dígitos y el RUC 11');
    if (!/^9\d{8}$/.test(tel)) err.push('el WhatsApp debe ser un celular de 9 dígitos que empiece con 9');
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) err.push('el correo no es válido');
    if (err.length) return res.status(400).json({ error: 'Revisa: ' + err.join('; ') + '.' });

    let conn;
    try {
      const R = await leerReglas(); const tc = await tcEfectivo(R);
      conn = await portalPool.getConnection();
      await conn.beginTransaction();
      const [[s]] = await conn.query(`SELECT ${COLS} FROM bk_skus WHERE id=? AND activo=1 FOR UPDATE`, [num(b.sku_id)]);
      if (!s) { await conn.rollback(); return res.status(404).json({ error: 'Esa combinación ya no está disponible. Actualiza la página.' }); }
      s.costo = num(s.costo);
      if (!sinLimite(s) && num(s.stock) - num(s.reservado) <= 0) { await conn.rollback(); return res.status(409).json({ error: `La talla ${s.talla} en ${s.color} se acaba de agotar. Elige otra o escríbenos por WhatsApp.` }); }
      const mods = await leerModelos();
      const ops = opcionesEnvio(s, R, tc, mods[s.marca + '|' + s.modelo] || {}).filter(o => !o.bajo);
      if (!ops.length) { await conn.rollback(); return res.status(409).json({ error: 'Esta bici ya no está disponible a pedido. Escríbenos por WhatsApp y te ayudamos.' }); }
      const op = ops.find(o => o.k === String(b.envio || '')) || ops[0];
      const env = op.k;
      const pago = String(b.pago || '0'); // '0' contado, '3'/'6'/… cuotas, 'pp' Powerpay
      const precioBici = pago === 'pp' && op.ppp ? op.ppp : pago === 't' && op.tj ? op.tj : (op.cq && op.cq[pago]) || op.p;
      const p = { ...calcularPrecio(s, env, R, tc, op.adicional ? num(R.margen_minimo) : null), pen: precioBici };
      const fechas = op.f;
      const pedidos = Array.isArray(b.extras) ? b.extras.map(String) : [];
      const extras = (R.extras || []).filter(e => e.incluido || pedidos.includes(e.id)).map(e => ({ id: e.id, nombre: e.nombre, precio: num(e.precio) }));
      const extrasTotal = extras.reduce((a, e) => a + e.precio, 0);
      const total = p.pen + extrasTotal;
      const usdM = R.moneda_principal !== 'PEN';
      const adelanto = usdM ? Math.round(Math.ceil(total / tc.usd * num(R.adelanto) / 100 / 10) * 10 * tc.usd) : ceil10(total * num(R.adelanto) / 100);
      const $ = v => usdM ? `US$ ${Math.round(v / tc.usd).toLocaleString('en-US')} (${soles(v)})` : soles(v);
      // Si la página mostró otro precio (cambió el TC o las reglas), avisar antes de guardar
      if (b.total_visto && Math.abs(num(b.total_visto) - total) >= 1 && !b.acepto_nuevo) {
        await conn.rollback();
        return res.status(409).json({ error: `El precio se actualizó a ${soles(total)}. Revisa y vuelve a confirmar.`, total_nuevo: total, cambio_precio: true });
      }
      const codigo = await nuevoCodigo(conn);
      const validoHasta = new Date(Date.now() + num(R.validez_horas || 48) * 3600e3);
      await conn.query(`INSERT INTO bk_reservas (codigo, sku_id, marca, modelo, montaje, talla, color, sku, envio, extras, precio_bici, extras_total, total, adelanto,
          tc_usd, costo_usd, valido_hasta, fecha_min, fecha_max, nombre, doc, tel, email, ciudad, ref, ip, pago)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [codigo, s.id, s.marca, s.modelo, s.montaje, s.talla, s.color, s.sku || null, env, JSON.stringify(extras), p.pen, extrasTotal, total, adelanto,
          tc.usd, Math.round(p.costoUSD * 100) / 100, validoHasta, fechas[0], fechas[1], nombre, doc, tel, email || null, ciudad, ref, ip, pago.slice(0, 4)]);
      await conn.query('UPDATE bk_skus SET reservado = reservado + 1 WHERE id=?', [s.id]);
      await conn.commit();
      limpiarCache();
      intentos.set('ok:' + ip, [...(intentos.get('ok:' + ip) || []), Date.now()]);

      const ENV_TXT = { lima: 'stock en Lima', aereo: 'aéreo', maritimo: 'marítimo', unidad: 'marítimo individual', grupo: 'marítimo en grupo' };
      let envTxt = ENV_TXT[env] || env;
      if (env === 'grupo') {
        const g = (await gruposPorMarca(R))[s.marca] || { min: Math.max(2, num(R.grupo_min) || 3), actual: 0, completos: 0 };
        envTxt += g.actual === 0 ? ` (¡grupo completo de ${g.min}!)` : ` (${g.actual} de ${g.min}; faltan ${g.min - g.actual})`;
      }
      const fechasTxt = `${fechaCorta(fechas[0])} – ${fechaCorta(fechas[1])}`;
      envTxt += pago === 'pp' ? ' · pago con Powerpay' : pago === 't' ? ' · tarjeta en 1 pago' : +pago > 1 ? ` · ${pago} cuotas sin intereses` : '';
      const msg = `Hola Kuranko, envié la solicitud de reserva ${codigo}: ${s.marca} ${s.modelo}${s.montaje && s.montaje !== 'Base' ? ' ' + s.montaje : ''}, talla ${s.talla}, color ${s.color}, envío ${envTxt}.\n` +
        `Precio final: ${$(total)} · Adelanto al confirmar: ${$(adelanto)}\nEntrega estimada: ${fechasTxt}\nNombre: ${nombre} · DNI/RUC: ${doc}\n¿Me confirman la disponibilidad?`;
      const fila = (a, v) => `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee;color:#666;font-size:14px">${escH(a)}</td><td style="padding:6px 10px;border-bottom:1px solid #eee;font-size:14px;color:#111"><b>${escH(v)}</b></td></tr>`;
      const tabla = [['Bici', `${s.marca} ${s.modelo} ${s.montaje}`], ['Talla / color', `${s.talla} · ${s.color}`], ['Envío', envTxt], ['Entrega estimada', fechasTxt],
        ['Extras', extras.map(e => e.nombre).join(', ') || '—'], ['Precio final', $(total)], [`Adelanto (${R.adelanto}%)`, $(adelanto)], ['Saldo al recibir', $(total - adelanto) + (usdM ? ' · fijo en dólares' : '')]].map(x => fila(...x)).join('');
      const caja = (titulo, extra) => `<div style="background:#f3f4f6;padding:16px;font-family:Arial,Helvetica,sans-serif"><div style="max-width:600px;margin:auto;background:#fff;border-radius:10px;padding:20px">
        <div style="font-size:20px;font-weight:bold;color:#111">${titulo}</div>${extra}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:12px">${tabla}</table></div></div>`;
      const wa = process.env.BIKES_WHATSAPP || '51963358335';
      const interno = caja(`Nueva solicitud de reserva ${escH(codigo)}`, `<p style="color:#444;font-size:14px">${escH(nombre)} · DNI/RUC ${escH(doc)} · WhatsApp ${escH(tel)}${email ? ' · ' + escH(email) : ''} · ${escH(ciudad)}${ref ? ' · vendedor: ' + escH(ref) : ''}</p>
        <p><a href="https://wa.me/51${escH(tel)}" style="background:#25d366;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;font-weight:bold;font-size:14px">Escribir al cliente</a></p>`);
      enviarCorreo((process.env.BIKES_EMAIL || 'info@kuranko.pe,ventas@kuranko.pe').split(',').map(x => x.trim()).filter(Boolean), `Solicitud ${codigo}: ${s.marca} ${s.modelo} ${s.talla} · ${$(total)} · confirmar con la marca`, interno, msg);
      if (email) enviarCorreo([email], `Tu solicitud de reserva ${codigo} en Kuranko Bikes`, caja(`Recibimos tu solicitud ${escH(codigo)}`,
        `<p style="color:#444;font-size:14px">Hola ${escH(nombre.split(' ')[0])}, no tienes que pagar nada todavía. Vamos a confirmar la disponibilidad con ${escH(s.marca)} y te escribiremos por WhatsApp al ${escH(tel)}, normalmente en menos de 24 horas hábiles.</p>
         <p style="color:#444;font-size:14px">Cuando esté confirmada, separas tu bici con el adelanto de ${escH($(adelanto))} (link de pago, Yape, transferencia o en tienda; también en cuotas). El saldo lo pagas al recibirla. El precio se mantiene ${escH(R.validez_horas)} horas.</p>
         <p style="color:#444;font-size:14px"><a href="https://bikes.kuranko.pe/bikes/proforma/${escH(codigo)}?doc=${escH(doc)}">Descarga tu proforma</a>. Consulta el estado en bikes.kuranko.pe con tu código y DNI. WhatsApp: +${escH(wa)}</p>`), msg);

      res.json({ ok: true, codigo, doc, total, adelanto, saldo: total - adelanto, tc: tc.usd, fechas, envio: env, mensaje: msg, whatsapp: wa });
    } catch (e) {
      if (conn) { try { await conn.rollback(); } catch (_) {} }
      console.error('[bikes] reservar', e.message);
      res.status(500).json({ error: 'No pudimos guardar la reserva. Intenta otra vez o escríbenos por WhatsApp.' });
    } finally { if (conn) conn.release(); }
  });

  // Agendar una llamada con el asesor
  const FRANJAS = ['10:00–12:00', '12:00–14:00', '14:00–16:00', '16:00–19:00'];
  app.post('/api/bikes/llamada', async (req, res) => {
    const b = req.body || {}; if (b.web) return res.json({ ok: true });
    const ip = ipDe(req);
    if (demasiados('ll:' + ip, 5)) return res.status(429).json({ error: 'Ya agendaste varias llamadas. Escríbenos por WhatsApp.' });
    const nombre = String(b.nombre || '').trim().slice(0, 120); let tel = String(b.tel || '').replace(/\D/g, ''); if (tel.length === 11 && tel.startsWith('51')) tel = tel.slice(2);
    const fecha = /^\d{4}-\d{2}-\d{2}$/.test(b.fecha || '') && b.fecha >= hoyLima() ? b.fecha : null;
    const franja = FRANJAS.includes(b.franja) ? b.franja : null;
    if (nombre.length < 3 || !/^9\d{8}$/.test(tel) || !fecha || !franja) return res.status(400).json({ error: 'Completa tu nombre, un celular de 9 dígitos, el día y la hora.' });
    try {
      await prepararTablas();
      const tema = String(b.tema || '').slice(0, 300), ref = String(b.ref || '').replace(/[^\w.\-]/g, '').slice(0, 60) || null;
      await portalPool.query('INSERT INTO bk_llamadas (nombre, tel, fecha, franja, tema, ref, ip) VALUES (?,?,?,?,?,?,?)', [nombre, tel, fecha, franja, tema, ref, ip]);
      const txt = `Llamada agendada: ${nombre} · ${tel} · ${fechaCorta(fecha)} ${franja}${tema ? ' · ' + tema : ''}`;
      enviarCorreo((process.env.BIKES_EMAIL || 'info@kuranko.pe,ventas@kuranko.pe').split(',').map(x => x.trim()).filter(Boolean), `Llamada agendada: ${nombre} · ${fechaCorta(fecha)} ${franja}`,
        `<div style="font-family:Arial,sans-serif;font-size:15px"><b>${escH(nombre)}</b> quiere una llamada el <b>${escH(fechaCorta(fecha))}</b> entre <b>${escH(franja)}</b>.<br>Celular: ${escH(tel)}${tema ? '<br>Tema: ' + escH(tema) : ''}${ref ? '<br>Vendedor: ' + escH(ref) : ''}<br><br><a href="https://wa.me/51${escH(tel)}">Escribir por WhatsApp</a></div>`, txt);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'No se pudo agendar. Escríbenos por WhatsApp.' }); }
  });

  app.get('/api/bikes/pedido', async (req, res) => {
    try {
      await prepararTablas();
      const codigo = String(req.query.codigo || '').trim().toUpperCase().slice(0, 12);
      const doc = String(req.query.doc || '').replace(/\D/g, '');
      if (demasiados('ped:' + ipDe(req), 30)) return res.status(429).json({ error: 'Demasiadas consultas. Intenta en una hora.' });
      const [[r]] = await portalPool.query(`SELECT codigo, marca, modelo, montaje, talla, color, envio, total, adelanto, estado,
          DATE_FORMAT(fecha_min,'%Y-%m-%d') fecha_min, DATE_FORMAT(fecha_max,'%Y-%m-%d') fecha_max,
          UNIX_TIMESTAMP(creado) creado, UNIX_TIMESTAMP(actualizado) actualizado
        FROM bk_reservas WHERE codigo=? AND doc=?`, [codigo, doc]);
      if (r) { r.creado = horaLima(r.creado).slice(0, 10); r.actualizado = horaLima(r.actualizado).slice(0, 10); }
      if (!r) return res.status(404).json({ error: 'No encontramos una reserva con ese código y documento.' });
      res.json({ ...r, total: num(r.total), adelanto: num(r.adelanto), estados: ESTADOS_RESERVA });
    } catch (e) { res.status(500).json({ error: 'No se pudo consultar. Intenta en un momento.' }); }
  });

  // ── Link propio por bici (/bici/<id>) con la foto y el precio para compartir por WhatsApp ──
  let htmlTienda = null;
  app.get('/bici/:id', async (req, res) => {
    try {
      if (!htmlTienda) htmlTienda = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'bikes.html'), 'utf8');
      const D = await catalogoPublico();
      const m = D.modelos.find(x => x.id === String(req.params.id || '').slice(0, 160));
      let h = htmlTienda;
      if (m) {
        const min = Math.min(...m.skus.map(x => x.pm));
        const precio = D.moneda === 'PEN' ? soles(min) : `US$ ${Math.round(min / D.tc_usd).toLocaleString('en-US')}`;
        const titulo = `${m.marca} ${m.modelo} · desde ${precio} · Kuranko`;
        const desc = (m.desc || `${m.marca} ${m.modelo} a pedido, precio final en Lima con envío, aduana e IGV.`).slice(0, 200);
        const url = `https://${req.hostname}/bici/${m.id}`;
        const meta = `<meta property="og:type" content="product"><meta property="og:title" content="${escH(titulo)}"><meta property="og:description" content="${escH(desc)}">` +
          `${m.img ? `<meta property="og:image" content="${escH(m.img)}">` : ''}<meta property="og:url" content="${escH(url)}"><meta name="twitter:card" content="summary_large_image">` +
          `<meta name="description" content="${escH(desc)}"><link rel="canonical" href="${escH(url)}">`;
        h = h.replace(/<title>[^<]*<\/title>/, `<title>${escH(titulo)}</title>${meta}`);
      }
      res.set('Cache-Control', 'no-cache').type('html').send(h);
    } catch (e) { res.status(500).send('No se pudo cargar'); }
  });

  // ── Proforma imprimible / PDF de una reserva (código + DNI/RUC) ──
  app.get('/bikes/proforma/:codigo', async (req, res) => {
    try {
      const codigo = String(req.params.codigo || '').toUpperCase().slice(0, 20), doc = String(req.query.doc || '').replace(/\D/g, '');
      if (demasiados('pf:' + ipDe(req), 60)) return res.status(429).send('Demasiadas consultas. Intenta en una hora.');
      await prepararTablas();
      const [[r]] = await portalPool.query(`SELECT codigo, UNIX_TIMESTAMP(creado) creado, UNIX_TIMESTAMP(valido_hasta) valido, marca, modelo, montaje, talla, color, envio, extras,
          precio_bici, extras_total, total, adelanto, tc_usd, DATE_FORMAT(fecha_min,'%Y-%m-%d') fmin, DATE_FORMAT(fecha_max,'%Y-%m-%d') fmax, nombre, doc, tel, email, ciudad, estado
        FROM bk_reservas WHERE codigo=? AND doc=?`, [codigo, doc]);
      if (!r) return res.status(404).send('No encontramos una reserva con ese código y documento.');
      const R = await leerReglas(), pg = await leerPagina(), info = await leerMarcas(), mods = await leerModelos();
      const tc = num(r.tc_usd) || 1, usdM = R.moneda_principal !== 'PEN';
      const $ = v => usdM ? `US$ ${Math.round(num(v) / tc).toLocaleString('en-US')}` : soles(v);
      const $2 = v => usdM ? `<span class="s">${soles(v)}</span>` : '';
      const fc = iso => iso ? new Date(iso + 'T12:00:00Z').toLocaleDateString('es-PE', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : '';
      const ENV = { lima: 'Unidad en tienda Kuranko', aereo: 'Aéreo', maritimo: 'Marítimo', unidad: 'Marítimo individual', grupo: 'Marítimo en grupo' };
      let extras = []; try { extras = JSON.parse(r.extras || '[]'); } catch (e) {}
      const gar = (info[r.marca] || {}).garantia || ((mods[r.marca + '|' + r.modelo] || {}).datos || {}).garantia || 'Garantía oficial del fabricante, gestionada por Kuranko en Lima.';
      const fila = (a, b, c = '') => `<tr><td>${a}</td><td class="n">${b}${c}</td></tr>`;
      const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Proforma ${escH(r.codigo)} · Kuranko</title><style>
*{box-sizing:border-box}body{font-family:Arial,Helvetica,sans-serif;color:#141414;background:#eee;margin:0;padding:24px 12px}
.hoja{max-width:800px;margin:auto;background:#fff;padding:36px 40px;border-radius:6px}
.top{display:flex;justify-content:space-between;gap:16px;border-bottom:3px solid #FBB911;padding-bottom:14px;flex-wrap:wrap}
.marca{font-size:26px;font-weight:900;letter-spacing:.04em}.chico{font-size:12px;color:#555;line-height:1.5}
h1{font-size:20px;margin:0 0 4px}h2{font-size:14px;text-transform:uppercase;letter-spacing:.06em;color:#555;margin:22px 0 8px}
table{width:100%;border-collapse:collapse;font-size:14px}td{padding:7px 4px;border-bottom:1px solid #e5e5e5;vertical-align:top}.n{text-align:right;white-space:nowrap}
.tot td{font-weight:900;font-size:17px;border-top:2px solid #141414}.s{display:block;font-size:12px;color:#666;font-weight:400}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:6px 24px;font-size:14px}.grid b{display:block;font-size:11px;color:#666;text-transform:uppercase;letter-spacing:.05em}
ul{margin:0;padding-left:18px;font-size:13px;line-height:1.55;color:#333}.bar{max-width:800px;margin:0 auto 12px;display:flex;gap:8px;justify-content:flex-end}
button{background:#FBB911;border:0;padding:10px 16px;font-weight:700;border-radius:6px;cursor:pointer;font-size:14px}
@media print{body{background:#fff;padding:0}.hoja{padding:0}.bar{display:none}}@media(max-width:600px){.hoja{padding:22px 18px}.grid{grid-template-columns:1fr}}
</style></head><body>
<div class="bar"><button onclick="window.print()">Descargar PDF / Imprimir</button></div>
<div class="hoja">
<div class="top"><div><div class="marca">KURANKO</div><div class="chico">${escH(pg.empresa || 'Kuranko')}${pg.ruc ? ' · RUC ' + escH(pg.ruc) : ''}<br>${escH(pg.direccion || 'Jr José Gálvez 476 Of 204, Magdalena del Mar, Lima')}<br>+${escH(process.env.BIKES_WHATSAPP || '51963358335')} · info@kuranko.pe</div></div>
<div style="text-align:right"><h1>Proforma ${escH(r.codigo)}</h1><div class="chico">Emitida: ${escH(horaLima(r.creado).slice(0, 10))}<br>Precio válido hasta: ${escH(horaLima(r.valido))}<br>Estado: ${escH(r.estado)}</div></div></div>
<h2>Cliente</h2><div class="grid"><div><b>Nombre</b>${escH(r.nombre)}</div><div><b>DNI / RUC</b>${escH(r.doc)}</div><div><b>WhatsApp</b>${escH(r.tel)}</div><div><b>Entrega</b>${escH(r.ciudad || 'Lima')}</div></div>
<h2>Bicicleta</h2><div class="grid"><div><b>Modelo</b>${escH(r.marca)} ${escH(r.modelo)}${r.montaje && r.montaje !== 'Base' ? ' ' + escH(r.montaje) : ''}</div><div><b>Talla / color</b>${escH(r.talla)} · ${escH(r.color)}</div>
<div><b>Envío</b>${escH(ENV[r.envio] || r.envio)}</div><div><b>Entrega estimada en Lima</b>${escH(fc(r.fmin))} – ${escH(fc(r.fmax))}</div></div>
<h2>Precio</h2><table>
${fila(`${escH(r.marca)} ${escH(r.modelo)} · incluye flete, seguro, desaduanaje, IGV y armado`, $(r.precio_bici), $2(r.precio_bici))}
${extras.map(e => fila(escH(e.nombre), e.precio ? $(e.precio) : 'incluido', e.precio ? $2(e.precio) : '')).join('')}
<tr class="tot"><td>Precio final</td><td class="n">${$(r.total)}${$2(r.total)}</td></tr>
${fila(`Adelanto (${num(R.adelanto)}%) para separar la unidad, al confirmar con la marca`, $(r.adelanto), $2(r.adelanto))}
${fila(`Saldo al recibir la bicicleta${usdM ? ' (fijo en dólares)' : ''}`, $(num(r.total) - num(r.adelanto)), $2(num(r.total) - num(r.adelanto)))}
</table>${usdM ? `<p class="chico">Tipo de cambio referencial: S/ ${tc.toFixed(3)} por dólar. Puedes pagar en dólares o en soles al tipo de cambio del día del pago.</p>` : ''}
<h2>Formas de pago</h2><ul><li>Link de pago con tarjeta de crédito o débito${R.cuotas_bancos ? `; cuotas sin intereses con ${escH(R.cuotas_bancos)}` : ''}${num(R.powerpay_pct) > 0 ? '; otras tarjetas en cuotas con Powerpay' : ''}.</li><li>Yape, transferencia bancaria o pago en nuestra tienda.</li>${pg.cuentas ? `<li>${escH(pg.cuentas)}</li>` : ''}</ul>
<h2>Garantía y soporte</h2><ul><li>${escH(gar)}</li><li>Bicicleta nueva, con comprobante de pago. Armado, ajuste de suspensión y fitting básico en nuestro taller de Magdalena.</li></ul>
<h2>Condiciones</h2><ul><li>Esta proforma no obliga al pago: la unidad se separa recién con el adelanto, después de que la marca confirme la disponibilidad.</li>
<li>Si la marca no puede entregar la unidad, devolvemos el 100% del adelanto.</li><li>Las fechas son estimadas y dependen de la marca, el transporte y la aduana. Te avisamos cualquier cambio.</li>
<li>El precio se mantiene hasta la fecha indicada arriba; luego puede actualizarse.</li></ul>
</div></body></html>`;
      res.set('Cache-Control', 'no-store').type('html').send(html);
    } catch (e) { console.error('[bikes] proforma', e.message); res.status(500).send('No se pudo generar la proforma.'); }
  });

  // Evento de métricas (lo manda la página con sendBeacon). Sin datos personales.
  const TIPOS_EV = ['visita', 'modelo', 'config', 'carrito', 'reserva', 'whatsapp', 'filtro'];
  app.post('/api/bikes/evento', express_text_o_json, async (req, res) => {
    res.status(204).end();
    try {
      let b = req.body; if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { return; } }
      const lista = (Array.isArray(b && b.ev) ? b.ev : [b]).slice(0, 20);
      if (demasiados('ev:' + ipDe(req), 600)) return;
      await prepararTablas();
      const filas = lista.filter(e => e && TIPOS_EV.includes(e.tipo) && /^[\w-]{6,24}$/.test(String(e.sesion || ''))).map(e => [
        String(e.sesion), e.tipo, e.marca ? String(e.marca).slice(0, 60) : null, e.modelo ? String(e.modelo).slice(0, 120) : null,
        num(e.sku_id) || null, num(e.valor) || null, e.ref ? String(e.ref).replace(/[^\w.\-]/g, '').slice(0, 60) : null,
        e.origen ? String(e.origen).slice(0, 120) : null, e.movil ? 1 : 0]);
      if (filas.length) await portalPool.query('INSERT INTO bk_eventos (sesion, tipo, marca, modelo, sku_id, valor, ref, origen, movil) VALUES ?', [filas]);
    } catch (e) { console.warn('[bikes] evento', e.message); }
  });

  // ── ADMIN ───────────────────────────────────────────────────────────────────
  // ── Stock de Kuranko desde el ERP (solo lectura): detecta las bicis que hay en tienda y las empareja con el catálogo ──
  let erpPool = null;
  const erp = () => erpPool || (process.env.PROD_URL ? (erpPool = require('mysql2/promise').createPool(process.env.PROD_URL + (process.env.PROD_URL.includes('?') ? '&' : '?') + 'connectionLimit=2')) : null);
  const NO_VENDIBLES = new Set((process.env.COTIZADOR_OTROS || process.env.COTIZADOR_NO_VENDIBLES || 'CUARENTENA,EN EXHIBICION,EMBAJADOR').split(',').map(x => norm(x)));
  // «Mondraker - bicicleta - Arid S 2026, 700c, Bronze, M/L» → { marca, modelo, color, talla }
  const tallaNorm = x => { const t = aTalla(x).replace(/\s+/g, ''); const u = { ML: 'M/L', SM: 'S/M', LXL: 'L/XL' }[t] || t; return RE_TALLA.test(u) ? u : ''; };
  function leerNombreERP(nombre) {
    const m = String(nombre).match(/^(.+?)\s*-?\s*(?:bicicletas?|e-?bikes?|bicicleta el[eé]ctrica)\s*-?\s*(.+)$/i);
    if (!m) return null;
    const partes = m[2].split(',').map(x => x.trim()).filter(Boolean);
    const modelo = (partes.shift() || '').replace(/\b(19|20)\d{2}\b/g, '').trim();
    let talla = '', color = '';
    if (partes.length && tallaNorm(partes[partes.length - 1])) talla = tallaNorm(partes.pop());
    const resto = partes.filter(x => !/^(\d{2}(?:[.,]5)?|700c|29|27[.,]5|mullet|mx)$/i.test(x));
    color = resto.join(' ');
    return { marca: m[1].trim(), modelo, talla, color };
  }
  async function sincronizarStockERP() {
    const db = erp(); if (!db) return { error: 'Sin conexión al ERP (PROD_URL)' };
    await prepararTablas();
    const [filas] = await db.query(`
      SELECT pv.id AS vid, pv.sku, pv.name AS variacion, p.name AS producto, l.name AS loc, l.type AS tipo, ls.quantity AS q, IFNULL(ls.reserved_quantity, 0) AS r
      FROM location_stocks ls JOIN locations l ON l.id = ls.location_id
      JOIN product_variations pv ON pv.id = ls.product_variation_id LEFT JOIN products p ON p.id = pv.product_id
      WHERE ls.quantity > 0 AND pv.deleted_at IS NULL AND (p.deleted_at IS NULL OR p.id IS NULL)
        AND (p.name LIKE '%bicicleta%' OR pv.name LIKE '%bicicleta%' OR p.name LIKE '%e-bike%' OR p.name LIKE '%ebike%')`);
    const porVid = new Map();
    for (const f of filas) {
      if (f.tipo === 'consignment' || NO_VENDIBLES.has(norm(f.loc))) continue;
      const nombre = f.variacion && String(f.variacion).toLowerCase().startsWith(String(f.producto || '').toLowerCase()) ? f.variacion : [f.producto, f.variacion].filter(Boolean).join(', ');
      const x = porVid.get(f.vid) || { vid: f.vid, sku: f.sku, nombre, qty: 0, locs: [] };
      x.qty += Math.max(0, num(f.q) - num(f.r)); if (!x.locs.includes(f.loc)) x.locs.push(f.loc); porVid.set(f.vid, x);
    }
    const [skus] = await portalPool.query('SELECT id, marca, modelo, talla, color, sku FROM bk_skus WHERE activo=1');
    const stock = new Map(), emparejadas = [], sin = [];
    for (const x of porVid.values()) {
      if (x.qty <= 0) continue;
      // 1) Por SKU de la marca si coincide; 2) por marca + modelo + talla (+ color)
      let cand = skus.filter(s => s.sku && x.sku && norm(s.sku) === norm(x.sku));
      const n = leerNombreERP(x.nombre);
      if (!cand.length && n) {
        // El modelo del ERP se empareja con los modelos del catálogo de esa marca con la misma regla que las fichas (ALU/CARBON, MX, etc.)
        const deMarca = skus.filter(s => norm(s.marca) === norm(n.marca));
        const mods = [...new Set(deMarca.map(s => s.modelo))];
        const exacto = mods.find(mo => tokensDe(mo).join(' ') === tokensDe(n.modelo).join(' '));
        const modelo = exacto || emparejarModelos([n.modelo], mods.map(mo => ({ slug: slug(mo), url: mo })))[n.modelo];
        cand = modelo ? deMarca.filter(s => s.modelo === modelo && (!n.talla || tallaNorm(s.talla) === n.talla)) : [];
        if (cand.length > 1 && n.color) { const tc = new Set(sinTildes(n.color).split(/[^a-z0-9]+/).filter(t => t.length > 2)); const c2 = cand.filter(s => sinTildes(s.color).split(/[^a-z0-9]+/).some(t => tc.has(t))); if (c2.length) cand = c2; }
      }
      if (cand.length) { const s = cand[0]; stock.set(s.id, (stock.get(s.id) || 0) + x.qty); emparejadas.push({ erp: x.nombre, qty: x.qty, sku_id: s.id, bici: `${s.marca} ${s.modelo} · ${s.talla} · ${s.color}`, dudoso: cand.length > 1 }); }
      else sin.push({ erp: x.nombre, qty: x.qty, locs: x.locs.join(', ') });
    }
    await portalPool.query('UPDATE bk_skus SET stock_kuranko=0 WHERE stock_kuranko<>0');
    for (const [id, q] of stock) await portalPool.query('UPDATE bk_skus SET stock_kuranko=? WHERE id=?', [q, id]);
    const estado = { t: Date.now(), en_tienda: [...stock.values()].reduce((a, b) => a + b, 0), emparejadas, sin_emparejar: sin };
    await portalPool.query(`INSERT INTO bk_config (clave, valor, actualizado_por) VALUES ('erp_stock', ?, 'sistema') ON DUPLICATE KEY UPDATE valor=VALUES(valor), actualizado=NOW()`, [JSON.stringify(estado)]);
    limpiarCache();
    return estado;
  }
  if (process.env.PROD_URL) { // cada 15 minutos
    setTimeout(() => sincronizarStockERP().catch(e => console.warn('[bikes] stock ERP', e.message)), 20000);
    setInterval(() => sincronizarStockERP().catch(e => console.warn('[bikes] stock ERP', e.message)), 15 * 60 * 1000);
  }
  app.get('/api/bikes/admin/stock-erp', authAdmin, mBikes, async (req, res) => {
    try { await prepararTablas(); const [[r]] = await portalPool.query(`SELECT valor FROM bk_config WHERE clave='erp_stock'`); res.json(r ? JSON.parse(r.valor) : { t: 0, emparejadas: [], sin_emparejar: [] }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/bikes/admin/stock-erp', authAdmin, mBikes, async (req, res) => {
    try { res.json(await sincronizarStockERP()); } catch (e) { res.status(500).json({ error: 'No se pudo leer el ERP: ' + e.message }); }
  });

  // Simulador de precios: muestra paso a paso cómo se llega al precio de una bici (para validar las reglas)
  app.post('/api/bikes/admin/simular', authAdmin, mBikes, async (req, res) => {
    try {
      const b = req.body || {}; const R = await leerReglas(); const tc = await tcEfectivo(R);
      let sku;
      if (b.sku_id) { const [[x]] = await portalPool.query(`SELECT ${COLS} FROM bk_skus WHERE id=?`, [num(b.sku_id)]); if (!x) throw new Error('SKU no encontrado'); sku = { ...x, costo: num(x.costo), pvp: num(x.pvp) }; }
      else sku = { marca: String(b.marca || ''), modelo: 'Simulación', categoria: b.ebike ? 'E-MTB' : 'MTB', motor: b.ebike ? 'sí' : '', costo: num(b.costo), pvp: num(b.pvp), moneda: b.moneda === 'EUR' ? 'EUR' : 'USD', estado: 'A pedido' };
      const mods = await leerModelos(); const md = mods[sku.marca + '|' + sku.modelo] || {}; const RM = reglasMarca(R, sku.marca);
      const igv = 1 + num(R.igv) / 100, usd = pen => Math.round(pen / tc.usd);
      const ops = opcionesEnvio(sku, R, tc, md).map(o => {
        const p = calcularPrecio(sku, o.k, R, tc, o.adicional ? num(R.margen_minimo) : null);
        const seguro = p.costoUSD * num(RM.seguro) / 100, arancel = (p.costoUSD + seguro + p.flete) * p.av / 100;
        const margenCon = (precio, pct) => { const sin = precio / igv / tc.usd; return { real: Math.round((sin * (1 - pct) - p.puesto) / sin * 1000) / 10, peor: Math.round((sin * (1 - pct) - p.cw) / sin * 1000) / 10 }; };
        return { envio: o.k, pasos: [['Costo de la bici', p.costoUSD], ['Seguro (' + num(RM.seguro) + '%)', seguro], ['Flete', p.flete], ['Ad valorem (' + p.av + '%, no recuperable)', arancel], [o.k === 'aereo' ? 'Otros gastos' : 'Gastos fijos del envío por bici (almacén, agente, etc.' + (esEbike(sku) ? ', IMO' : '') + ')', p.fijos], ['= Costo puesto en Lima (sin IGV)', p.puesto], ['Peor caso (+' + num(RM.variacion_costos ?? 25) + '% logística, +2% TC)', p.cw]].map(([k, v]) => ({ k, v: Math.round(v) })),
          modo: p.modo, precio_regla: usd(p.pen), precio_minimo: o.sub ? usd(o.p) : null, contado: { usd: usd(o.p), pen: o.p, ...margenCon(o.p, 0) },
          cuotas: Object.entries(o.cq || {}).map(([n, v]) => ({ n: +n, pct: num((R.cuotas || {})[n]), usd: usd(v), pen: v, ...margenCon(v, num((R.cuotas || {})[n]) / 100) })),
          tarjeta: o.tj ? { pct: num(R.tarjeta_pct), usd: usd(o.tj), pen: o.tj, ...margenCon(o.tj, num(R.tarjeta_pct) / 100) } : null,
          powerpay: o.ppp ? { pct: num(R.powerpay_pct), usd: usd(o.ppp), pen: o.ppp, ...margenCon(o.ppp, num(R.powerpay_pct) / 100) } : null };
      });
      // Validación: el modelo contra costos reales de importaciones de Mondraker (costo sin impuestos deducibles, US$)
      const REALES = [['Arid S · marítimo (IMP-70)', 1250, false, 'maritimo', 1427], ['Chrono Carbon DC · marítimo (IMP-70)', 1085.4, false, 'maritimo', 1243],
        ['F-Podium RR · marítimo (IMP-70)', 4058.56, false, 'maritimo', 4544], ['Crafty Carbon RR e-bike · marítimo (IMP-70)', 4351.6, true, 'maritimo', 4781],
        ['Crafty Carbon XR e-bike · marítimo (IMP-70)', 6594, true, 'maritimo', 7203], ['Arid S · aéreo (IMP-82)', 1250, false, 'aereo', 1870], ['Summum R · aéreo (IMP-73)', 2931, false, 'aereo', 3706]];
      const validacion = REALES.map(([nombre, exw, eb, env, real]) => { const x = calcularPrecio({ marca: 'Mondraker', costo: exw, moneda: 'USD', categoria: eb ? 'E-MTB' : 'MTB', motor: eb ? 'sí' : '', estado: 'A pedido' }, env, R, tc);
        return { nombre, exw, real, modelo: Math.round(x.puesto), dif: Math.round((x.puesto - real) / real * 1000) / 10 }; });
      res.json({ validacion, origen: (R.marca_origen || {})[sku.marca] || 'General', tc: tc.usd, igv: num(R.igv), margen_minimo: num(R.margen_minimo), pvp: sku.pvp, factor: (R.factores_pvp || {})[sku.marca] ?? R.factor_pvp_defecto, modo: (R.modos || {})[sku.marca] || 'costo', sku: { marca: sku.marca, modelo: sku.modelo, costo: sku.costo }, ops });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.post('/api/bikes/admin/metricas/reiniciar', authAdmin, mBikes, async (req, res) => {
    try { await prepararTablas(); const [r] = await portalPool.query('DELETE FROM bk_eventos'); res.json({ ok: true, borrados: r.affectedRows }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.get('/api/bikes/admin/metricas', authAdmin, mBikes, async (req, res) => {
    try {
      await prepararTablas();
      const dias = Math.min(365, Math.max(1, Math.round(num(req.query.dias) || 30)));
      const desde = `DATE_SUB(NOW(), INTERVAL ${dias} DAY)`;
      const [embudo] = await portalPool.query(`SELECT tipo, COUNT(*) eventos, COUNT(DISTINCT sesion) sesiones FROM bk_eventos WHERE creado >= ${desde} GROUP BY tipo`);
      const [modelos] = await portalPool.query(`SELECT marca, modelo,
          SUM(tipo='modelo') clics, COUNT(DISTINCT IF(tipo='modelo', sesion, NULL)) personas,
          COUNT(DISTINCT IF(tipo='carrito', sesion, NULL)) carrito, COUNT(DISTINCT IF(tipo='reserva', sesion, NULL)) reservas,
          COUNT(DISTINCT IF(tipo='whatsapp', sesion, NULL)) whatsapp
        FROM bk_eventos WHERE creado >= ${desde} AND modelo IS NOT NULL GROUP BY marca, modelo ORDER BY clics DESC LIMIT 200`);
      const [diario] = await portalPool.query(`SELECT DATE_FORMAT(CONVERT_TZ(creado,'+00:00','-05:00'),'%Y-%m-%d') dia,
          COUNT(DISTINCT IF(tipo='visita', sesion, NULL)) visitas, COUNT(DISTINCT IF(tipo='modelo', sesion, NULL)) modelo,
          COUNT(DISTINCT IF(tipo='carrito', sesion, NULL)) carrito, COUNT(DISTINCT IF(tipo='reserva', sesion, NULL)) reservas
        FROM bk_eventos WHERE creado >= ${desde} GROUP BY dia ORDER BY dia`);
      const [refs] = await portalPool.query(`SELECT COALESCE(ref,'(directo)') ref, COUNT(DISTINCT IF(tipo='visita', sesion, NULL)) visitas,
          COUNT(DISTINCT IF(tipo='carrito', sesion, NULL)) carrito, COUNT(DISTINCT IF(tipo='reserva', sesion, NULL)) reservas
        FROM bk_eventos WHERE creado >= ${desde} GROUP BY ref ORDER BY visitas DESC LIMIT 50`);
      const [origenes] = await portalPool.query(`SELECT COALESCE(origen,'(directo)') origen, COUNT(DISTINCT sesion) visitas FROM bk_eventos
        WHERE creado >= ${desde} AND tipo='visita' GROUP BY origen ORDER BY visitas DESC LIMIT 20`);
      const [[mov]] = await portalPool.query(`SELECT COUNT(DISTINCT IF(movil=1, sesion, NULL)) movil, COUNT(DISTINCT sesion) total FROM bk_eventos WHERE creado >= ${desde} AND tipo='visita'`);
      res.json({ dias, embudo, modelos, diario, refs, origenes, movil: mov });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/bikes/admin/estado', authAdmin, mBikes, async (req, res) => {
    try {
      const R = await leerReglas(); const tc = await tcEfectivo(R);
      const skus = await leerSkus(false);
      const mods = await leerModelos();
      const conPrecio = skus.map(s => {
        const ops = opcionesEnvio(s, R, tc, mods[s.marca + '|' + s.modelo] || {});
        const p = calcularPrecio(s, ops[0].k, R, tc);
        const ms = ops.flatMap(o => [o.mb, o.ma]);
        const pf = ops[0].p, gan = pf / (1 + num(R.igv) / 100) / tc.usd - p.puesto;
        return { ...s, precio: pf, puesto: Math.round(p.puesto), ganancia: Math.round(gan), margen: ops[0].margen,
          envios: ops.map(o => ({ k: o.k, p: o.p, margen: o.margen, mb: Math.floor(o.mb), ma: Math.ceil(o.ma), ...(o.sub ? { sub: 1 } : {}) })), margen_min: Math.min(...ms), margen_max: Math.max(...ms),
          pvp_pen: s.pvp > 0 ? ceil10(s.pvp * (s.moneda === 'EUR' ? tc.eur : tc.usd)) : null };
      });
      const [reservas] = await portalPool.query(`SELECT id, codigo, UNIX_TIMESTAMP(creado) creado, sku_id, marca, modelo, montaje, talla, color, envio, extras,
          total, adelanto, tc_usd, DATE_FORMAT(fecha_min,'%Y-%m-%d') fecha_min, DATE_FORMAT(fecha_max,'%Y-%m-%d') fecha_max, nombre, doc, tel, email, ciudad, ref,
          estado, nota_interna, venta_erp, UNIX_TIMESTAMP(valido_hasta) valido_hasta, UNIX_TIMESTAMP(actualizado) actualizado, actualizado_por
        FROM bk_reservas ORDER BY id DESC LIMIT 500`);
      const [imports] = await portalPool.query(`SELECT id, UNIX_TIMESTAMP(creado) creado, usuario, archivo, marcas, modo, nuevas, actualizadas, desactivadas FROM bk_imports ORDER BY id DESC LIMIT 20`);
      res.json({ reglas: R, tc, maestro: !!(req.admin && req.admin.maestro), skus: conPrecio, reservas: reservas.map(r => ({ ...r, total: num(r.total), adelanto: num(r.adelanto),
          creado: horaLima(r.creado), actualizado: horaLima(r.actualizado), valido_hasta: horaLima(r.valido_hasta), vencida: r.estado === 'Nueva' && r.valido_hasta && r.valido_hasta * 1000 < Date.now() })),
        modelos: mods, marcas_info: await leerMarcas(), pagina: await leerPagina(),
        llamadas: (await portalPool.query(`SELECT id, UNIX_TIMESTAMP(creado) creado, nombre, tel, DATE_FORMAT(fecha,'%Y-%m-%d') fecha, franja, tema, ref, estado, nota FROM bk_llamadas ORDER BY (estado='Pendiente') DESC, fecha, id DESC LIMIT 200`))[0].map(l => ({ ...l, creado: horaLima(l.creado) })), grupos: await gruposPorMarca(R),
        imports: imports.map(i => ({ ...i, creado: horaLima(i.creado) })), estados_reserva: ESTADOS_RESERVA, estados_sku: ESTADOS_SKU, marcas_base: MARCAS_BASE });
    } catch (e) { console.error('[bikes] estado', e.message); res.status(500).json({ error: e.message }); }
  });

  app.put('/api/bikes/admin/reglas', authAdmin, mBikes, async (req, res) => {
    if (!(req.admin && req.admin.maestro)) return res.status(403).json({ error: 'Solo el administrador maestro puede cambiar las reglas de precio' });
    try {
      const actual = await leerReglas();
      const b = req.body || {};
      const nuevo = { ...actual };
      for (const k of Object.keys(REGLAS_BASE)) {
        if (b[k] === undefined) continue;
        if (k === 'margenes') { nuevo.margenes = {}; for (const [m, v] of Object.entries(b.margenes || {})) if (isFinite(+v) && +v >= 0 && +v < 90) nuevo.margenes[String(m).slice(0, 60)] = +v; }
        else if (k === 'modos') { nuevo.modos = {}; for (const [m, v] of Object.entries(b.modos || {})) nuevo.modos[String(m).slice(0, 60)] = v === 'pvp' ? 'pvp' : 'costo'; }
        else if (k === 'factores_pvp') { nuevo.factores_pvp = {}; for (const [m, v] of Object.entries(b.factores_pvp || {})) if (+v > 0.5 && +v < 3) nuevo.factores_pvp[String(m).slice(0, 60)] = +v; }
        else if (k === 'extras') nuevo.extras = (Array.isArray(b.extras) ? b.extras : []).slice(0, 12).map((e, i) => ({ id: slug(e.id || e.nombre) || 'x' + i, nombre: String(e.nombre || '').slice(0, 120), precio: Math.max(0, num(e.precio)), incluido: !!e.incluido })).filter(e => e.nombre);
        else if (k === 'tc_modo') nuevo.tc_modo = b.tc_modo === 'manual' ? 'manual' : 'auto';
        else if (k === 'aereo_activo') nuevo.aereo_activo = !!b.aereo_activo;
        else if (k === 'cuotas_bancos') nuevo.cuotas_bancos = String(b.cuotas_bancos || '').slice(0, 120);
        else if (k === 'solo_completos') nuevo.solo_completos = !!b.solo_completos;
        else if (k === 'origenes') { nuevo.origenes = {}; for (const [n, o] of Object.entries(b.origenes || {}).slice(0, 20)) { const nom = String(n).trim().slice(0, 40); if (!nom) continue; nuevo.origenes[nom] = {};
            for (const c of CLAVES_ORIGEN) if (o && o[c] !== '' && o[c] != null && isFinite(+o[c]) && +o[c] >= 0) nuevo.origenes[nom][c] = +o[c]; } }
        else if (k === 'marca_origen') { nuevo.marca_origen = {}; for (const [m, o] of Object.entries(b.marca_origen || {})) if (o) nuevo.marca_origen[String(m).slice(0, 60)] = String(o).slice(0, 40); }
        else if (k === 'moneda_principal') nuevo.moneda_principal = b.moneda_principal === 'PEN' ? 'PEN' : 'USD';
        else if (k === 'cuotas') { nuevo.cuotas = {}; for (const [n, v] of Object.entries(b.cuotas || {})) if (+n >= 2 && +n <= 36 && +v >= 0 && +v < 40) nuevo.cuotas[+n] = +v; }
        else if (isFinite(+b[k]) && +b[k] >= 0) nuevo[k] = +b[k];
      }
      if (nuevo.margen_defecto >= 90 || nuevo.adelanto > 100 || nuevo.mar_min > nuevo.mar_max || nuevo.aereo_min > nuevo.aereo_max || nuevo.aduana_min > nuevo.aduana_max || nuevo.lima_min > nuevo.lima_max)
        return res.status(400).json({ error: 'Revisa los valores: el margen debe ser menor a 90%, el adelanto hasta 100% y cada mínimo no puede superar su máximo.' });
      await portalPool.query(`INSERT INTO bk_config (clave, valor, actualizado_por) VALUES ('reglas', ?, ?)
        ON DUPLICATE KEY UPDATE valor=VALUES(valor), actualizado=NOW(), actualizado_por=VALUES(actualizado_por)`, [JSON.stringify(nuevo), usuarioDe(req)]);
      limpiarCache();
      res.json({ ok: true, reglas: mezclarReglas(nuevo) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Reconoce columnas: primero por nombre; si faltan las clave, pregunta a la IA.
  app.post('/api/bikes/admin/mapear', authAdmin, mBikes, async (req, res) => {
    // Si llegan las primeras filas del Excel, se elige como encabezado la que más columnas reconoce
    let fila_encabezado = null;
    if (Array.isArray(req.body && req.body.primeras)) {
      let mejor = -1;
      req.body.primeras.slice(0, 25).forEach((f, i) => { const n = Object.keys(reconocerColumnas((f || []).map(c => String(c == null ? '' : c))).map).length; if (n > mejor) { mejor = n; fila_encabezado = i; } });
      req.body.headers = req.body.primeras[fila_encabezado];
      req.body.muestra = req.body.primeras.slice(fila_encabezado + 1).filter(f => (f || []).filter(c => c !== '' && c != null).length > 2).slice(0, 5);
    }
    const headers = (Array.isArray(req.body && req.body.headers) ? req.body.headers : []).slice(0, 80).map(h => String(h == null ? '' : h).slice(0, 80));
    const muestra = (Array.isArray(req.body && req.body.muestra) ? req.body.muestra : []).slice(0, 6).map(r => (Array.isArray(r) ? r : []).slice(0, 80).map(c => String(c == null ? '' : c).slice(0, 60)));
    const r = reconocerColumnas(headers);
    if (r.map.stock != null && r.map.fecha_disponible == null && muestra.length && muestra.filter(f => /[a-z]/i.test(String(f[r.map.stock] || ''))).length > muestra.length / 2) {
      r.map.fecha_disponible = r.map.stock; r.conf.fecha_disponible = 0.8; delete r.map.stock; delete r.conf.stock;
    }
    const faltan = ['modelo', 'costo'].filter(k => r.map[k] == null).concat(r.map.talla == null && !r.tallas_cols.length ? ['talla'] : []);
    let fuente = 'nombres';
    const key = process.env.GEMINI_API_KEY;
    if ((faltan.length || req.body.forzar_ia) && key) {
      try {
        const campos = Object.keys(CAMPOS).join(', ');
        const prompt = `Eres un asistente que lee listas de precios de bicicletas enviadas por marcas o distribuidores.
Columnas (índice: encabezado): ${headers.map((h, i) => `${i}: ${h}`).join(' | ')}
Filas de ejemplo: ${JSON.stringify(muestra)}
Asigna a cada campo el índice de la columna que corresponde, o null si no existe. Campos: ${campos}.
"costo" es el precio que paga la tienda/distribuidor (dealer, net, EK, FOB), NO el precio sugerido al público (que es "pvp").
Si las tallas están como columnas separadas con cantidades (S, M, L…), devuélvelas en "tallas_cols" como [{"i": índice, "talla": "M"}].
Responde solo JSON: {"map": {"campo": índice|null}, "tallas_cols": [], "moneda": "USD"|"EUR"|null, "nota": "breve"}`;
        const txt = await llamarGemini(prompt, 0, 25000);
        if (!txt) throw new Error(ultimoErrorIA || 'sin respuesta');
        const ia = JSON.parse(txt);
        for (const [k, v] of Object.entries(ia.map || {})) {
          if (CAMPOS[k] && Number.isInteger(v) && v >= 0 && v < headers.length && r.map[k] == null) { r.map[k] = v; r.conf[k] = 0.7; }
        }
        if (!r.tallas_cols.length && Array.isArray(ia.tallas_cols)) r.tallas_cols = ia.tallas_cols.filter(t => Number.isInteger(t.i) && t.i < headers.length).map(t => ({ i: t.i, talla: aTalla(t.talla) }));
        if (ia.moneda === 'EUR' || ia.moneda === 'USD') r.moneda = ia.moneda;
        r.nota = String(ia.nota || '').slice(0, 300);
        fuente = 'nombres + IA';
      } catch (e) { console.warn('[bikes] mapear IA', e.message); r.nota = 'La IA no respondió; revisa las columnas a mano.'; }
    } else if (faltan.length && !key) r.nota = 'Falta GEMINI_API_KEY para que la IA ayude; elige las columnas a mano.';
    res.json({ ...r, fuente, campos: Object.keys(CAMPOS), fila_encabezado });
  });

  // Importar filas (ya mapeadas por campo). simular=true solo devuelve la vista previa.
  app.post('/api/bikes/admin/importar', authAdmin, mBikes, async (req, res) => {
    const b = req.body || {};
    const crudas = Array.isArray(b.filas) ? b.filas.slice(0, 5000) : [];
    if (!crudas.length) return res.status(400).json({ error: 'No hay filas para importar' });
    const def = { marca: String(b.marca || '').trim(), moneda: b.moneda === 'EUR' ? 'EUR' : 'USD', stock_defecto: b.stock_defecto != null && b.stock_defecto !== '' ? num(b.stock_defecto) : null };
    const modo = b.modo === 'reemplazar' ? 'reemplazar' : 'actualizar';
    const hoy = hoyLima();
    const norms = crudas.map(r => normalizarFila(r || {}, def, hoy));
    const validas = norms.filter(n => n.valida).map(n => n.fila);
    const conErrores = norms.map((n, i) => ({ i, errores: n.errores, valida: n.valida })).filter(x => x.errores.length);
    // Duplicados dentro del archivo: se suma el stock
    const porClave = new Map();
    for (const f of validas) { const k = claveSku(f); const prev = porClave.get(k); if (prev) prev.stock = (prev.stock < 0 || f.stock < 0) ? -1 : prev.stock + f.stock; else porClave.set(k, { ...f }); }
    const filas = [...porClave.values()];
    const marcas = [...new Set(filas.map(f => f.marca))];
    try {
      const R = await leerReglas(); const tc = await tcEfectivo(R);
      await prepararTablas();
      const [exist] = marcas.length ? await portalPool.query(`SELECT id, marca, modelo, montaje, talla, color, sku, activo, reservado FROM bk_skus WHERE marca IN (?)`, [marcas]) : [[]];
      const mapa = new Map(exist.map(e => [claveSku(e), e]));
      const nuevas = filas.filter(f => !mapa.has(claveSku(f))).length;
      const actualizadas = filas.length - nuevas;
      const vistas = new Set(filas.map(claveSku));
      const desactivar = modo === 'reemplazar' ? exist.filter(e => e.activo && !vistas.has(claveSku(e))) : [];
      if (b.simular) {
        return res.json({ simulacion: true, total: crudas.length, validas: filas.length, nuevas, actualizadas, desactivadas: desactivar.length, marcas,
          errores: conErrores.slice(0, 200), marcas_nuevas: marcas.filter(m => !MARCAS_BASE.includes(m)),
          vista: filas.slice(0, 300).map(f => ({ ...f, precio: calcularPrecio(f, 'maritimo', R, tc).pen, entrega: calcularEntrega(f, 'maritimo', R, hoy), nueva: !mapa.has(claveSku(f)) })) });
      }
      const conn = await portalPool.getConnection();
      try {
        await conn.beginTransaction();
        const [ins] = await conn.query(`INSERT INTO bk_imports (usuario, archivo, marcas, modo, nuevas, actualizadas, desactivadas) VALUES (?,?,?,?,?,?,?)`,
          [usuarioDe(req), String(b.archivo || '').slice(0, 200), marcas.join(', ').slice(0, 300), modo, nuevas, actualizadas, desactivar.length]);
        const impId = ins.insertId;
        const campos = ['marca', 'modelo', 'montaje', 'anio', 'categoria', 'aro', 'recorrido', 'material', 'motor', 'talla', 'color', 'color_hex', 'sku', 'costo', 'moneda', 'pvp', 'stock', 'estado', 'fecha_disponible', 'peso', 'url_imagen', 'url_ficha', 'notas'];
        for (const f of filas) {
          const e = mapa.get(claveSku(f));
          if (e) await conn.query(`UPDATE bk_skus SET ${campos.map(c => c + '=?').join(', ')}, activo=1, import_id=?, actualizado=NOW() WHERE id=?`, [...campos.map(c => f[c]), impId, e.id]);
          else await conn.query(`INSERT INTO bk_skus (${campos.join(', ')}, import_id) VALUES (${campos.map(() => '?').join(', ')}, ?)`, [...campos.map(c => f[c]), impId]);
        }
        if (desactivar.length) await conn.query(`UPDATE bk_skus SET activo=0, actualizado=NOW() WHERE id IN (?)`, [desactivar.map(d => d.id)]);
        await conn.commit();
      } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
      limpiarCache();
      res.json({ ok: true, nuevas, actualizadas, desactivadas: desactivar.length, marcas, errores: conErrores.length });
    } catch (e) { console.error('[bikes] importar', e.message); res.status(500).json({ error: e.message }); }
  });

  // Editar un SKU (activar/desactivar, stock, estado, fecha)
  app.post('/api/bikes/admin/sku', authAdmin, mBikes, async (req, res) => {
    const b = req.body || {};
    const ids = (Array.isArray(b.ids) ? b.ids : [b.id]).map(num).filter(x => x > 0).slice(0, 2000);
    if (!ids.length) return res.status(400).json({ error: 'Falta el SKU' });
    const sets = [], vals = [];
    if (b.activo !== undefined) { sets.push('activo=?'); vals.push(b.activo ? 1 : 0); }
    if (b.stock !== undefined && isFinite(+b.stock) && +b.stock >= -1) { sets.push('stock=?'); vals.push(Math.round(+b.stock)); }
    if (b.estado !== undefined && ESTADOS_SKU.includes(b.estado)) { sets.push('estado=?'); vals.push(b.estado); }
    if (b.fecha_disponible !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(b.fecha_disponible)) { sets.push('fecha_disponible=?'); vals.push(b.fecha_disponible); }
    if (b.costo !== undefined && +b.costo > 0) { sets.push('costo=?'); vals.push(+b.costo); }
    if (b.url_imagen !== undefined) { sets.push('url_imagen=?'); vals.push(/^https?:\/\//i.test(b.url_imagen) ? String(b.url_imagen).slice(0, 500) : null); }
    if (!sets.length) return res.status(400).json({ error: 'Nada que cambiar' });
    try {
      await prepararTablas();
      await portalPool.query(`UPDATE bk_skus SET ${sets.join(', ')}, actualizado=NOW() WHERE id IN (?)`, [...vals, ids]);
      limpiarCache(); res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/bikes/admin/llamada', authAdmin, mBikes, async (req, res) => {
    const b = req.body || {};
    try { await portalPool.query('UPDATE bk_llamadas SET estado=?, nota=? WHERE id=?', [['Pendiente', 'Hecha', 'No contestó', 'Cancelada'].includes(b.estado) ? b.estado : 'Pendiente', String(b.nota || '').slice(0, 1000), num(b.id)]); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Cambiar estado / nota / N° de venta del ERP de una reserva
  app.post('/api/bikes/admin/reserva', authAdmin, mBikes, async (req, res) => {
    const b = req.body || {};
    let conn;
    try {
      await prepararTablas();
      conn = await portalPool.getConnection();
      await conn.beginTransaction();
      const [[r]] = await conn.query('SELECT id, sku_id, estado FROM bk_reservas WHERE id=? FOR UPDATE', [num(b.id)]);
      if (!r) { await conn.rollback(); return res.status(404).json({ error: 'Reserva no encontrada' }); }
      const sets = ['actualizado=NOW()', 'actualizado_por=?'], vals = [usuarioDe(req)];
      if (b.estado !== undefined) {
        if (!ESTADOS_RESERVA.includes(b.estado)) { await conn.rollback(); return res.status(400).json({ error: 'Estado no válido' }); }
        sets.push('estado=?'); vals.push(b.estado);
        // Libera o vuelve a tomar la unidad reservada
        if (b.estado === 'Cancelada' && r.estado !== 'Cancelada') await conn.query('UPDATE bk_skus SET reservado=GREATEST(reservado-1,0) WHERE id=?', [r.sku_id]);
        if (b.estado !== 'Cancelada' && r.estado === 'Cancelada') await conn.query('UPDATE bk_skus SET reservado=reservado+1 WHERE id=?', [r.sku_id]);
        // Al entregar, la unidad deja de contar como stock de la marca
        if (b.estado === 'Entregada' && r.estado !== 'Entregada') await conn.query('UPDATE bk_skus SET reservado=GREATEST(reservado-1,0), stock=IF(stock<0, stock, GREATEST(stock-1,0)) WHERE id=?', [r.sku_id]);
        if (r.estado === 'Entregada' && b.estado !== 'Entregada') await conn.query('UPDATE bk_skus SET reservado=reservado+(?), stock=IF(stock<0, stock, stock+1) WHERE id=?', [b.estado === 'Cancelada' ? 0 : 1, r.sku_id]);
      }
      if (b.nota_interna !== undefined) { sets.push('nota_interna=?'); vals.push(String(b.nota_interna).slice(0, 2000)); }
      if (b.venta_erp !== undefined) { sets.push('venta_erp=?'); vals.push(String(b.venta_erp).trim().slice(0, 40) || null); }
      await conn.query(`UPDATE bk_reservas SET ${sets.join(', ')} WHERE id=?`, [...vals, r.id]);
      await conn.commit(); limpiarCache();
      res.json({ ok: true });
    } catch (e) { if (conn) { try { await conn.rollback(); } catch (_) {} } res.status(500).json({ error: e.message }); }
    finally { if (conn) conn.release(); }
  });

  // Datos de cada marca para la tienda: logo (link o imagen subida) y si acepta envío aéreo
  async function leerMarcas() {
    await prepararTablas();
    const [[row]] = await portalPool.query(`SELECT valor FROM bk_config WHERE clave='marcas'`);
    try { return row ? JSON.parse(row.valor) : {}; } catch (e) { return {}; }
  }
  app.post('/api/bikes/admin/marca', authAdmin, mBikes, async (req, res) => {
    const b = req.body || {}; const marca = String(b.marca || '').trim().slice(0, 60);
    if (!marca) return res.status(400).json({ error: 'Falta la marca' });
    const logo = String(b.logo || '');
    if (logo && !/^https?:\/\//i.test(logo) && !/^data:image\/(png|jpe?g|webp|svg\+xml);base64,/i.test(logo)) return res.status(400).json({ error: 'El logo debe ser un link o una imagen PNG, JPG, WEBP o SVG' });
    if (logo.length > 400000) return res.status(400).json({ error: 'El logo pesa mucho (máx. 300 KB)' });
    try {
      const m = await leerMarcas();
      m[marca] = { ...(m[marca] || {}) };
      if (b.logo !== undefined) m[marca].logo = logo || null;
      if (b.visible !== undefined) m[marca].visible = !!b.visible; // false = la marca no se muestra en la tienda
      if (b.garantia !== undefined) m[marca].garantia = String(b.garantia || '').trim().slice(0, 200) || null;
      if (b.url_modelos !== undefined) m[marca].url_modelos = /^https?:\/\//i.test(b.url_modelos || '') ? String(b.url_modelos).trim().slice(0, 1200) : null;
      await portalPool.query(`INSERT INTO bk_config (clave, valor, actualizado_por) VALUES ('marcas', ?, ?) ON DUPLICATE KEY UPDATE valor=VALUES(valor), actualizado=NOW(), actualizado_por=VALUES(actualizado_por)`, [JSON.stringify(m), usuarioDe(req)]);
      limpiarCache(); res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Traer fotos y descripción desde el link del modelo en la web de la marca
  app.post('/api/bikes/admin/ficha', authAdmin, mBikes, async (req, res) => {
    try { res.json(await leerFicha(String((req.body && req.body.url) || '').trim(), { nombre: String((req.body && req.body.nombre) || '') })); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.post('/api/bikes/admin/modelo', authAdmin, mBikes, async (req, res) => {
    const b = req.body || {};
    const marca = String(b.marca || '').slice(0, 60), modelo = String(b.modelo || '').slice(0, 120);
    if (!marca || !modelo) return res.status(400).json({ error: 'Falta el modelo' });
    const imgs = (Array.isArray(b.imagenes) ? b.imagenes : []).filter(u => /^https?:\/\//i.test(u)).slice(0, 12).map(u => String(u).slice(0, 600));
    const ok = v => ['auto', 'si', 'no'].includes(v) ? v : 'auto';
    try {
      await prepararTablas();
      const specs = (Array.isArray(b.specs) ? b.specs : null);
      await portalPool.query(`INSERT INTO bk_modelos (marca, modelo, descripcion, imagenes, url_ficha, aereo, unidad, specs, img_colores, manual) VALUES (?,?,?,?,?,?,?,?,?,1)
        ON DUPLICATE KEY UPDATE descripcion=VALUES(descripcion), imagenes=VALUES(imagenes), url_ficha=VALUES(url_ficha), aereo=VALUES(aereo), unidad=VALUES(unidad),
          specs=IFNULL(VALUES(specs), specs), img_colores=VALUES(img_colores), manual=1, actualizado=NOW()`,
        [marca, modelo, String(b.descripcion || '').slice(0, 4000), JSON.stringify(imgs), /^https?:\/\//i.test(b.url_ficha || '') ? String(b.url_ficha).slice(0, 500) : null, ok(b.aereo), ok(b.unidad),
          specs ? JSON.stringify(specs.slice(0, 25).map(x => ({ k: String(x.k || '').slice(0, 40), v: String(x.v || '').slice(0, 200) })).filter(x => x.k && x.v)) : null,
          JSON.stringify(Object.fromEntries(Object.entries(b.img_colores && typeof b.img_colores === 'object' ? b.img_colores : {}).filter(([u]) => imgs.includes(u)).map(([u, c]) => [u, String(c || '').slice(0, 80)])))]);
      limpiarCache(); res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Vitrina del modelo: destacado, etiqueta (novedad / lanzamiento / próximamente) y stock confirmado
  app.post('/api/bikes/admin/modelo-vitrina', authAdmin, mBikes, async (req, res) => {
    const b = req.body || {};
    const marca = String(b.marca || '').slice(0, 60), modelo = String(b.modelo || '').slice(0, 120);
    if (!marca || !modelo) return res.status(400).json({ error: 'Falta el modelo' });
    const sets = [], vals = [];
    if (b.destacado !== undefined) { sets.push('destacado'); vals.push(b.destacado ? 1 : 0); }
    if (b.confirmado !== undefined) { sets.push('confirmado'); vals.push(b.confirmado ? 1 : 0); }
    if (b.etiqueta !== undefined) { sets.push('etiqueta'); vals.push(['novedad', 'lanzamiento', 'proximamente'].includes(b.etiqueta) ? b.etiqueta : ''); }
    if (!sets.length) return res.status(400).json({ error: 'Nada que cambiar' });
    try {
      await prepararTablas();
      await portalPool.query(`INSERT INTO bk_modelos (marca, modelo, ${sets.join(', ')}) VALUES (?,?,${sets.map(() => '?').join(',')}) ON DUPLICATE KEY UPDATE ${sets.map(c => `${c}=VALUES(${c})`).join(', ')}`, [marca, modelo, ...vals]);
      limpiarCache(); res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Modelo de IA elegido desde el panel (sin tocar Railway) y lista de modelos disponibles en Google
  app.get('/api/bikes/admin/ia', authAdmin, mBikes, async (req, res) => {
    const key = process.env.GEMINI_API_KEY;
    if (key) modelosIA.t = 0; // refresca la lista al abrir el panel
    if (key) await modelosDisponibles(key);
    res.json({ elegido: modeloIAelegido, ultimo_ok: modeloIAok, lista: modelosIA.todos, clave: !!key, pruebas: pruebasIA });
  });
  app.post('/api/bikes/admin/ia', authAdmin, mBikes, async (req, res) => {
    const b = req.body || {};
    try {
      if (b.modelo !== undefined) {
        modeloIAelegido = String(b.modelo || '').replace(/^models\//, '').replace(/[^a-zA-Z0-9.\-]/g, '').slice(0, 60);
        await portalPool.query(`INSERT INTO bk_config (clave, valor, actualizado_por) VALUES ('ia', ?, ?) ON DUPLICATE KEY UPDATE valor=VALUES(valor), actualizado=NOW(), actualizado_por=VALUES(actualizado_por)`, [JSON.stringify({ modelo: modeloIAelegido }), usuarioDe(req)]);
      }
      if (b.probar_todos) { // prueba cada modelo disponible y devuelve cuáles funcionan
        const key = process.env.GEMINI_API_KEY; if (!key) return res.json({ pruebas: [] });
        await modelosDisponibles(key);
        const ids = modelosIA.todos.map(m => m.id).slice(0, 16), out = [];
        for (let i = 0; i < ids.length; i += 4) out.push(...await Promise.all(ids.slice(i, i + 4).map(id => probarModelo(key, id))));
        pruebasIA = { t: Date.now(), r: out };
        return res.json({ pruebas: pruebasIA });
      }
      if (b.probar) {
        const t0 = Date.now(); const txt = await llamarGemini('Responde solo este JSON: {"ok": true}', 0, 20000);
        return res.json({ ok: !!txt, modelo: txt ? modeloIAok : null, ms: Date.now() - t0, error: txt ? null : ultimoErrorIA });
      }
      res.json({ ok: true, elegido: modeloIAelegido });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Disponibilidad confirmada por la marca (sello en la tienda)
  app.post('/api/bikes/admin/modelo-confirmado', authAdmin, mBikes, async (req, res) => {
    const b = req.body || {};
    const marca = String(b.marca || '').slice(0, 60), modelo = String(b.modelo || '').slice(0, 120);
    if (!marca || !modelo) return res.status(400).json({ error: 'Falta el modelo' });
    try {
      await prepararTablas();
      await portalPool.query(`INSERT INTO bk_modelos (marca, modelo, confirmado) VALUES (?,?,?) ON DUPLICATE KEY UPDATE confirmado=VALUES(confirmado)`, [marca, modelo, b.confirmado ? 1 : 0]);
      limpiarCache(); res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Carga masiva de fichas: un link de la web de la marca → todos los modelos ──
  // 1) Busca en esa página los links de modelos y los empareja con los modelos del catálogo de esa marca.
  // 2) Recorre cada link (uno cada ~1.5 s) y guarda fotos, descripción y especificaciones (con IA si hay GEMINI_API_KEY).
  //    Los modelos editados a mano no se pisan, salvo que se pida "sobrescribir".
  let trabajo = null;
  app.post('/api/bikes/admin/fichas-masivo', authAdmin, mBikes, async (req, res) => {
    const b = req.body || {}; const marca = String(b.marca || '').trim();
    if (trabajo && trabajo.corriendo) return res.status(409).json({ error: 'Ya hay una carga en curso', trabajo });
    if (b.todas) return completarTodas(req, res, !!b.sobrescribir);
    if (!marca) return res.status(400).json({ error: 'Elige la marca' });
    try {
      await prepararTablas();
      const info = await leerMarcas();
      if (!b.url && !b.pares && (info[marca] || {}).url_modelos) b.url = info[marca].url_modelos;
      if (b.url && !b.iniciar && /^https?:\/\//i.test(b.url)) { // recordar el link de la marca para la próxima vez
        info[marca] = { ...(info[marca] || {}), url_modelos: String(b.url).trim().slice(0, 1200) };
        await portalPool.query(`INSERT INTO bk_config (clave, valor, actualizado_por) VALUES ('marcas', ?, ?) ON DUPLICATE KEY UPDATE valor=VALUES(valor)`, [JSON.stringify(info), usuarioDe(req)]);
      }
      const [mods] = await portalPool.query('SELECT DISTINCT modelo FROM bk_skus WHERE marca=? AND activo=1 ORDER BY modelo', [marca]);
      const modelos = mods.map(r => r.modelo);
      let pares = b.pares && typeof b.pares === 'object' ? b.pares : null;
      if (!pares) {
        const { links, diag } = await linksDeVarias(b.url);
        pares = emparejarModelos(modelos, links);
        if (!links.length) return res.status(400).json({ error: 'No encontré links de modelos en esa página. Lo que recibió el servidor: ' + diag.join(' · ') });
        if (!Object.keys(pares).length) return res.status(400).json({ error: `Leí ${links.length} links pero ninguno coincide con tus modelos. Ejemplos de lo que encontré: ${links.slice(0, 8).map(l => l.slug).join(', ')}. ${diag.join(' · ')}` });
      }
      const sin = modelos.filter(m => !pares[m]);
      if (!b.iniciar) return res.json({ pares, sin, total: modelos.length });
      const existentes = await leerModelos();
      const lista = Object.entries(pares).filter(([m, u]) => modelos.includes(m) && /^https?:\/\//.test(u) && (b.sobrescribir || !(existentes[marca + '|' + m] || {}).manual));
      trabajo = { marca, total: lista.length, hechos: 0, ok: 0, errores: [], corriendo: true, inicio: Date.now() };
      res.json({ iniciado: true, trabajo });
      await procesarFichas(lista.map(([modelo, url]) => [marca, modelo, url]));
    } catch (e) {
      if (trabajo && trabajo.corriendo) { trabajo.corriendo = false; trabajo.errores.push(e.message); }
      if (!res.headersSent) res.status(400).json({ error: e.message });
    }
  });
  app.get('/api/bikes/admin/fichas-masivo', authAdmin, mBikes, (req, res) => res.json({ trabajo }));

  // ── Lector desde el navegador: para marcas que bloquean al servidor ──
  // 1) La ventana del lector manda los links de la página de la marca → se emparejan con los modelos del catálogo
  app.post('/api/bikes/admin/lector/emparejar', authAdmin, mBikes, async (req, res) => {
    const b = req.body || {}; const marca = String(b.marca || '').trim();
    try {
      await prepararTablas();
      const [mods] = await portalPool.query('SELECT DISTINCT modelo FROM bk_skus WHERE marca=? AND activo=1 ORDER BY modelo', [marca]);
      const existentes = await leerModelos();
      const modelos = mods.map(x => x.modelo).filter(m => b.sobrescribir || !(existentes[marca + '|' + m] || {}).manual);
      const links = filtrarLinks((Array.isArray(b.links) ? b.links : []).slice(0, 3000), String(b.origen || ''));
      const pares = emparejarModelos(modelos, links);
      // Lo que ya tiene cada modelo guardado (para no volver a traer lo que está completo)
      const previo = {};
      for (const m of modelos) { const md = existentes[marca + '|' + m] || {}, d = { ...datosDeSpecs(md.specs || []), ...(md.datos || {}) };
        previo[m] = { fotos: (md.imgs || []).length, specs: (md.specs || []).length, descripcion: !!String(md.desc || '').trim(), geometria: d.geometria ? d.geometria.filas.length : 0,
          geo_img: !!d.geo, recorrido: !!d.rec_del, material: !!d.material, peso: !!d.peso }; }
      const completo = p => p.fotos > 0 && p.specs > 0 && p.descripcion && (p.geometria > 0 || p.geo_img);
      // ¿La página donde se tocó el marcador es la ficha de un modelo? (para traer solo esa)
      let actual = null;
      try { const o = new URL(String(b.origen || '')); const sl = o.pathname.split('/').filter(Boolean).pop() || '';
        const todos = mods.map(x => x.modelo); const pm = emparejarModelos(todos, [{ slug: sl, url: o.href }]);
        const m1 = Object.keys(pm).sort((x, y) => tokensDe(y).length - tokensDe(x).length)[0];
        if (m1) actual = { modelo: m1, url: o.href, manual: !!(existentes[marca + '|' + m1] || {}).manual }; } catch (e) {}
      res.json({ actual, todos_modelos: mods.map(x => x.modelo), pares, sin: modelos.filter(m => !pares[m]), total: modelos.length, links: links.length, previo,
        completos: modelos.filter(m => completo(previo[m])) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  // 2) Por cada modelo, la ventana manda fotos y texto leídos en el navegador → IA → se guarda
  app.post('/api/bikes/admin/lector/ficha', authAdmin, mBikes, async (req, res) => {
    const b = req.body || {}; const marca = String(b.marca || '').trim().slice(0, 60), modelo = String(b.modelo || '').trim().slice(0, 120), url = String(b.url || '').slice(0, 500);
    if (!marca || !modelo || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Faltan datos' });
    try {
      const f = await fichaDesdeNavegador(url, b.imgs, b.texto, marca + ' ' + modelo);
      await portalPool.query(`INSERT INTO bk_modelos (marca, modelo, descripcion, imagenes, url_ficha, specs, datos, manual) VALUES (?,?,?,?,?,?,?,0)
        ON DUPLICATE KEY UPDATE descripcion=VALUES(descripcion), imagenes=IF(VALUES(imagenes)='[]', imagenes, VALUES(imagenes)), url_ficha=VALUES(url_ficha),
          specs=VALUES(specs), datos=VALUES(datos), manual=0, actualizado=NOW()`,
        [marca, modelo, String(f.descripcion || '').slice(0, 4000), JSON.stringify(f.imagenes || []), url, JSON.stringify(f.specs || []), JSON.stringify(f.datos || {})]);
      limpiarCache();
      const d = f.datos || {};
      res.json({ ok: true, fotos: f.imagenes.length, specs: (f.specs || []).length, descripcion: !!f.descripcion, ia: !!f.ia, ia_error: f.ia_error || null,
        geometria: d.geometria ? d.geometria.filas.length : 0, geo_img: !!d.geo, recorrido: !!d.rec_del, material: !!d.material, tallas: Array.isArray(d.tallas) && d.tallas.length > 0, peso: !!d.peso });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // Lee cada ficha con IA y la guarda. lista = [[marca, modelo, url]]
  async function procesarFichas(lista) {
    for (const [marca, modelo, url] of lista) {
      try {
        const f = await leerFicha(url, { nombre: marca + ' ' + modelo });
        await portalPool.query(`INSERT INTO bk_modelos (marca, modelo, descripcion, imagenes, url_ficha, specs, datos, manual) VALUES (?,?,?,?,?,?,?,0)
          ON DUPLICATE KEY UPDATE descripcion=VALUES(descripcion), imagenes=IF(VALUES(imagenes)='[]', imagenes, VALUES(imagenes)), url_ficha=VALUES(url_ficha),
            specs=VALUES(specs), datos=VALUES(datos), manual=0, actualizado=NOW()`,
          [marca, modelo, String(f.descripcion || '').slice(0, 4000), JSON.stringify(f.imagenes || []), url.slice(0, 500), JSON.stringify(f.specs || []), JSON.stringify(f.datos || {})]);
        trabajo.ok++;
        if (f.ia_error && !trabajo.errores.some(x => x.startsWith('IA'))) trabajo.errores.unshift(`${f.ia_error} · se completó sin IA (descripción armada con las especificaciones)`);
      } catch (e) { trabajo.errores.push(`${marca} ${modelo}: ${e.message}`.slice(0, 200)); }
      trabajo.hechos++;
      await new Promise(r => setTimeout(r, 1500));
    }
    trabajo.corriendo = false; limpiarCache();
  }

  // Un clic: todas las marcas con link guardado, solo los modelos con ficha incompleta
  async function completarTodas(req, res, sobrescribir) {
    try {
      await prepararTablas();
      const info = await leerMarcas(), existentes = await leerModelos();
      const [rows] = await portalPool.query('SELECT marca, modelo, MAX(url_imagen) url_imagen FROM bk_skus WHERE activo=1 GROUP BY marca, modelo');
      const porMarca = {}; rows.forEach(r => (porMarca[r.marca] ||= []).push(r));
      const lista = [], sinLink = [];
      for (const [marca, mods] of Object.entries(porMarca)) {
        const falta = mods.filter(r => { const md = existentes[r.marca + '|' + r.modelo] || {}; return (sobrescribir || !md.manual) && fichaCompleta(md, r.url_imagen ? [r] : []).length; }).map(r => r.modelo);
        if (!falta.length) continue;
        const url = (info[marca] || {}).url_modelos;
        if (!url) { sinLink.push(marca); continue; }
        try {
          const { links, diag } = await linksDeVarias(url);
          if (!links.length) { sinLink.push(`${marca} (${diag.join(' · ')})`); continue; }
          const pares = emparejarModelos(falta, links);
          for (const m of falta) if (pares[m]) lista.push([marca, m, pares[m]]); else sinLink.push(`${marca} ${m}`);
        } catch (e) { sinLink.push(`${marca} (${e.message})`); }
      }
      if (!lista.length) return res.json({ trabajo: null, sin: sinLink, nota: 'No hay modelos por completar con link encontrado.' });
      trabajo = { marca: 'Todas', total: lista.length, hechos: 0, ok: 0, errores: sinLink.length ? [`Sin link (complétalos a mano o pon el link de la marca): ${sinLink.join(', ')}`.slice(0, 600)] : [], corriendo: true, inicio: Date.now() };
      res.json({ iniciado: true, trabajo });
      await procesarFichas(lista);
    } catch (e) {
      if (trabajo && trabajo.corriendo) { trabajo.corriendo = false; trabajo.errores.push(e.message); }
      if (!res.headersSent) res.status(400).json({ error: e.message });
    }
  }

  // ── Página: fotos reales (portada, asesor, taller) y datos del asesor ──
  const CLAVES_FOTO = ['hero', 'asesor', 'taller', 'taller2'];
  async function leerPagina() {
    await prepararTablas();
    const [[row]] = await portalPool.query(`SELECT valor FROM bk_config WHERE clave='pagina'`);
    try { return row ? JSON.parse(row.valor) : {}; } catch (e) { return {}; }
  }
  app.post('/api/bikes/admin/pagina', authAdmin, mBikes, async (req, res) => {
    const b = req.body || {};
    try {
      const pg = await leerPagina();
      for (const k of ['asesor_nombre', 'asesor_cargo', 'asesor_whatsapp', 'soporte_url', 'soporte_texto', 'empresa', 'ruc', 'direccion', 'cuentas']) if (b[k] !== undefined) pg[k] = String(b[k]).trim().slice(0, k === 'soporte_texto' || k === 'cuentas' ? 400 : 120);
      if (b.foto && CLAVES_FOTO.includes(b.foto.clave)) {
        const d = String(b.foto.dato || '');
        if (d && !/^data:image\/(png|jpe?g|webp);base64,/i.test(d)) return res.status(400).json({ error: 'La foto debe ser JPG, PNG o WEBP' });
        if (d.length > 1.6e6) return res.status(400).json({ error: 'La foto pesa mucho (máx. 1.2 MB). Redúcela antes de subirla.' });
        await portalPool.query(`INSERT INTO bk_config (clave, valor, actualizado_por) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE valor=VALUES(valor), actualizado=NOW(), actualizado_por=VALUES(actualizado_por)`, ['foto_' + b.foto.clave, d, usuarioDe(req)]);
        pg.fotos = { ...(pg.fotos || {}), [b.foto.clave]: d ? Date.now() : null };
      }
      await portalPool.query(`INSERT INTO bk_config (clave, valor, actualizado_por) VALUES ('pagina', ?, ?) ON DUPLICATE KEY UPDATE valor=VALUES(valor), actualizado=NOW(), actualizado_por=VALUES(actualizado_por)`, [JSON.stringify(pg), usuarioDe(req)]);
      limpiarCache(); res.json({ ok: true, pagina: pg });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  // Foto pública (se sirve como imagen, con caché)
  app.get('/api/bikes/foto/:clave', async (req, res) => {
    if (!CLAVES_FOTO.includes(req.params.clave)) return res.status(404).end();
    try {
      await prepararTablas();
      const [[row]] = await portalPool.query(`SELECT valor FROM bk_config WHERE clave=?`, ['foto_' + req.params.clave]);
      const m = row && String(row.valor).match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
      if (!m) return res.status(404).end();
      res.set({ 'Content-Type': m[1], 'Cache-Control': 'public, max-age=86400' }).send(Buffer.from(m[2], 'base64'));
    } catch (e) { res.status(500).end(); }
  });

  // Exportar el catálogo en el formato de la plantilla (para editar en Excel y volver a subir)
  app.get('/api/bikes/admin/exportar', authAdmin, mBikes, async (req, res) => {
    try {
      const ExcelJS = require('exceljs');
      const R = await leerReglas(); const tc = await tcEfectivo(R);
      const skus = await leerSkus(req.query.todos !== '1');
      const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Bicis');
      const cols = ['marca', 'modelo', 'montaje', 'anio', 'categoria', 'aro', 'recorrido', 'material', 'motor_bateria', 'talla', 'color', 'color_hex', 'sku', 'costo', 'moneda',
        'pvp_sugerido', 'stock', 'estado', 'fecha_disponible', 'peso_kg', 'url_imagen', 'url_ficha', 'notas', 'reservado', 'precio_final_PEN', 'activo'];
      ws.columns = cols.map(c => ({ header: c, key: c, width: Math.max(12, c.length + 3) }));
      skus.forEach(s => ws.addRow({ ...s, motor_bateria: s.motor, pvp_sugerido: s.pvp, peso_kg: s.peso, precio_final_PEN: calcularPrecio(s, 'maritimo', R, tc).pen, activo: s.activo ? 'sí' : 'no' }));
      ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1D4A3A' } };
      ws.views = [{ state: 'frozen', ySplit: 1 }];
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="bikes-catalogo-${hoyLima()}.xlsx"`);
      await wb.xlsx.write(res); res.end();
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return { prepararTablas };
};

module.exports._test = { fichaCompleta, elegirImagenes, htmlATexto, specsSimples, linksDeModelos, emparejarModelos, leerFichaHtml, opcionesEnvio, leerMenuKuranko, MENU_RESPALDO, calcularPrecio, calcularEntrega, reconocerColumnas, normalizarFila, aFecha, aNumero, armarCatalogo, mezclarReglas, claveSku, REGLAS_BASE };
