// ═══════════════════════════════════════════════════════════════════════════
//  MÓDULO: Seguimiento de envíos (trackings) + gestión de Backorders
//
//  Idea (lo pediste tú):
//   1) La factura se sube y revisa UNA SOLA VEZ, en Importaciones (Factura → SKU).
//      Desde ahí, «🚚 Enviar a seguimiento» crea aquí el envío con sus líneas
//      (código, descripción en español, cantidad, SKU y confianza) SIN PRECIOS.
//      Aquí solo se le asigna el TRACKING y la logística. Las líneas de esos
//      envíos son de SOLO LECTURA: se corrigen en Importaciones y se reenvían.
//      (Los envíos antiguos, creados subiendo la factura aquí, siguen editables.)
//   1b) Cuando llega, «📥 Enviar a almacén» crea la recepción desde el envío.
//      Cuando el almacén CONFIRMA, el envío toma los SKU y cantidades reales
//      (lo que vio el almacenero) y se recalcula la cobertura de backorders.
//   2) El envío queda con su tracking y sus ítems. Se marca cuáles de esos
//      ítems corresponden a productos en BACKORDER (los que un cliente ya pidió
//      y están esperando stock). Así el SUPERVISOR ve, con el tracking, qué está
//      llegando y con cuánta confianza, y cuáles cubren backorders.
//   3) GESTIÓN DE BACKORDERS: la lista de pedidos a la espera de stock se lee
//      del ERP (sale_items.is_backorder = 1, SOLO LECTURA) y se "fija" en el
//      portal para poder gestionarla: marcar cuáles YA compraste, escribir una
//      NOTA por ítem (por qué no lo has comprado / cuándo lo comprarás) y
//      organizarlos en GRUPOS con nombre. Cada grupo lleva info de la venta:
//      VTA, cliente, precio de venta y precio ya pagado.
//
//  Permisos:
//   · LEER  todo → cualquier admin con el módulo 'seguimiento' (incluye al
//     supervisor). El supervisor VE los envíos, trackings, confianza,
//     backorders y la info de venta de los grupos.
//   · ESCRIBIR (subir factura, IA, asignar tracking, gestionar backorders,
//     grupos) → SOLO el maestro. El supervisor no sube nada.
//
//  Almacenamiento:
//   · prodPool (ERP de Renzo) → SOLO LECTURA: catálogo y líneas de backorder.
//   · portalPool → tablas seg_* (envíos, backorders gestionados, grupos).
//   · La factura NO se guarda (ni el PDF): solo la tabla de líneas ya leída.
//   · seg_envios.items_factura = líneas tal como llegaron de Importaciones;
//     seg_envios.items = esas líneas ajustadas con la confirmación del almacén.
// ═══════════════════════════════════════════════════════════════════════════

const { rutaCatalogo, nombrePorSku } = require('./comunes');

module.exports = function registrarSeguimiento({
  app, authAdmin, requiereModulo, prodPool, portalPool, recepciones
}) {

  const mSeg = requiereModulo('seguimiento'); // lectura: admin con el módulo (el maestro pasa)

  // Throttle de la sincronización con el ERP (lo más costoso). El botón
  // "Actualizar" fuerza; la sincronización automática al abrir respeta este límite.
  let _lastSyncSeg = 0;
  const SYNC_TTL_SEG = 3 * 60 * 1000;

  // Escritura: SOLO el maestro. El supervisor únicamente visualiza.
  function soloMaestroSeg(req, res, next) {
    if (!req.admin || !req.admin.maestro)
      return res.status(403).json({ error: 'Solo el administrador puede modificar el seguimiento.' });
    next();
  }

  // ── Preparar tablas del portal (se llama una vez al arrancar) ──────────────
  async function prepararTablas() {
    // Grupos de backorder (con info de la venta). Un grupo agrupa varios ítems.
    await portalPool.query(`
      CREATE TABLE IF NOT EXISTS seg_grupos (
        id             VARCHAR(40) PRIMARY KEY,
        nombre         VARCHAR(200) NOT NULL DEFAULT '',
        vta            VARCHAR(120) NOT NULL DEFAULT '',
        cliente        VARCHAR(255) NOT NULL DEFAULT '',
        precio_venta   DECIMAL(12,2) NULL,
        precio_pagado  DECIMAL(12,2) NULL,
        nota           TEXT,
        orden          INT NOT NULL DEFAULT 0,
        creado_en      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        actualizado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )`);

    // Ítems de backorder GESTIONADOS. Se "fijan" desde el ERP (origen='erp',
    // id = 'erp:'+sale_item_id) o se agregan a mano (origen='manual').
    await portalPool.query(`
      CREATE TABLE IF NOT EXISTS seg_bo_items (
        id             VARCHAR(60) PRIMARY KEY,
        grupo_id       VARCHAR(40) NULL,
        sku            VARCHAR(120) NOT NULL DEFAULT '',
        nombre         VARCHAR(255) NOT NULL DEFAULT '',
        cliente        VARCHAR(255) NOT NULL DEFAULT '',
        venta          VARCHAR(120) NOT NULL DEFAULT '',
        cantidad       INT NULL,
        fecha          DATE NULL,
        comprado       TINYINT(1) NOT NULL DEFAULT 0,
        nota           TEXT,
        orden          INT NOT NULL DEFAULT 0,
        origen         VARCHAR(10) NOT NULL DEFAULT 'erp',
        archivado      TINYINT(1) NOT NULL DEFAULT 0,
        envio_id       VARCHAR(40) NULL,
        tracking       VARCHAR(400) NOT NULL DEFAULT '',
        cubierto       INT NOT NULL DEFAULT 0,
        coberturas     JSON NULL,
        creado_en      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        actualizado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX (grupo_id), INDEX (sku), INDEX (comprado), INDEX (archivado), INDEX (envio_id)
      )`);
    // Por si la tabla ya existía sin estas columnas (vínculo/tracking/cantidades cubiertas).
    try { await portalPool.query(`ALTER TABLE seg_bo_items ADD COLUMN envio_id VARCHAR(40) NULL`); } catch (e) {}
    try { await portalPool.query(`ALTER TABLE seg_bo_items ADD COLUMN tracking VARCHAR(400) NOT NULL DEFAULT ''`); } catch (e) {}
    try { await portalPool.query(`ALTER TABLE seg_bo_items MODIFY tracking VARCHAR(400) NOT NULL DEFAULT ''`); } catch (e) {}
    try { await portalPool.query(`ALTER TABLE seg_bo_items ADD COLUMN cubierto INT NOT NULL DEFAULT 0`); } catch (e) {}
    try { await portalPool.query(`ALTER TABLE seg_bo_items ADD COLUMN coberturas JSON NULL`); } catch (e) {}

    // Envíos (trackings) con sus ítems leídos de la factura (tabla, no el PDF).
    await portalPool.query(`
      CREATE TABLE IF NOT EXISTS seg_envios (
        id             VARCHAR(40) PRIMARY KEY,
        tracking       VARCHAR(160) NOT NULL DEFAULT '',
        courier        VARCHAR(80)  NOT NULL DEFAULT '',
        proveedor      VARCHAR(255) NOT NULL DEFAULT '',
        n_factura      VARCHAR(160) NOT NULL DEFAULT '',
        estado         VARCHAR(20)  NOT NULL DEFAULT 'en_transito',
        fecha_estimada DATE NULL,
        nota           TEXT,
        items          JSON NOT NULL,
        creado_por     VARCHAR(120) NOT NULL DEFAULT '',
        archivado      TINYINT(1) NOT NULL DEFAULT 0,
        creado_en      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        actualizado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX (tracking), INDEX (estado)
      )`);
    // Por si la tabla ya existía sin la columna de archivado.
    try { await portalPool.query(`ALTER TABLE seg_envios ADD COLUMN archivado TINYINT(1) NOT NULL DEFAULT 0`); } catch (e) {}
    // ── Logística de 2 tramos + estado del courier (tramo 1 por API) ──────────
    try { await portalPool.query(`ALTER TABLE seg_envios ADD COLUMN hub VARCHAR(20) NOT NULL DEFAULT ''`); } catch (e) {}          // miami | madrid | espana | otro
    try { await portalPool.query(`ALTER TABLE seg_envios ADD COLUMN fase VARCHAR(20) NOT NULL DEFAULT 'transito'`); } catch (e) {} // transito | en_hub | embarcado | recibido
    try { await portalPool.query(`ALTER TABLE seg_envios ADD COLUMN fecha_salida DATE NULL`); } catch (e) {}                      // (legado) salida del hub
    try { await portalPool.query(`ALTER TABLE seg_envios ADD COLUMN fecha_hub DATE NULL`); } catch (e) {}                         // fecha en que llegó al hub (base del ETA)
    try { await portalPool.query(`ALTER TABLE seg_envios ADD COLUMN eta DATE NULL`); } catch (e) {}                               // llegada estimada a Perú
    try { await portalPool.query(`ALTER TABLE seg_envios ADD COLUMN api_resumen VARCHAR(255) NOT NULL DEFAULT ''`); } catch (e) {}// resumen legible del courier
    try { await portalPool.query(`ALTER TABLE seg_envios ADD COLUMN api_estado VARCHAR(40) NOT NULL DEFAULT ''`); } catch (e) {}  // estado crudo del courier
    try { await portalPool.query(`ALTER TABLE seg_envios ADD COLUMN api_at DATETIME NULL`); } catch (e) {}                        // última lectura por API
    try { await portalPool.query(`ALTER TABLE seg_envios ADD COLUMN api_eventos JSON NULL`); } catch (e) {}                      // historial completo de eventos del courier (traducido)
    try { await portalPool.query(`ALTER TABLE seg_envios ADD COLUMN api_entrega DATE NULL`); } catch (e) {}                       // fecha de entrega real según el courier
    // ── Vínculo con Importaciones / Recepción ─────────────────────────────────
    try { await portalPool.query(`ALTER TABLE seg_envios ADD COLUMN origen VARCHAR(20) NOT NULL DEFAULT 'manual'`); } catch (e) {} // manual (legado) | importacion
    try { await portalPool.query(`ALTER TABLE seg_envios ADD COLUMN importacion_id VARCHAR(80) NOT NULL DEFAULT ''`); } catch (e) {} // = id de recepción (código + factura)
    try { await portalPool.query(`ALTER TABLE seg_envios ADD INDEX idx_seg_imp (importacion_id)`); } catch (e) {}
    try { await portalPool.query(`ALTER TABLE seg_envios ADD COLUMN codigo VARCHAR(80) NOT NULL DEFAULT ''`); } catch (e) {}       // código de importación
    try { await portalPool.query(`ALTER TABLE seg_envios ADD COLUMN empresa VARCHAR(255) NOT NULL DEFAULT ''`); } catch (e) {}
    try { await portalPool.query(`ALTER TABLE seg_envios ADD COLUMN items_factura JSON NULL`); } catch (e) {}                    // líneas tal cual vinieron de Importaciones
    try { await portalPool.query(`ALTER TABLE seg_envios ADD COLUMN recep_id VARCHAR(80) NOT NULL DEFAULT ''`); } catch (e) {}    // recepción creada desde este envío
    try { await portalPool.query(`ALTER TABLE seg_envios ADD COLUMN recep_conf_at DATETIME NULL`); } catch (e) {}                // cuándo se aplicó la confirmación del almacén

    // Token de seguimiento público por CLIENTE (link que se comparte al cliente).
    await portalPool.query(`
      CREATE TABLE IF NOT EXISTS seg_cliente_token (
        token     VARCHAR(40) PRIMARY KEY,
        cliente   VARCHAR(255) NOT NULL,
        creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX (cliente)
      )`);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  const asJson = (v, fb) => {
    if (v == null) return fb;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch (e) { return fb; }
  };
  const s = (v) => (v == null ? '' : String(v));
  // Fecha → 'YYYY-MM-DD'. mysql2 devuelve columnas DATE como objeto Date, por lo que
  // String(fecha).slice(0,10) daría "Mon Oct 12" (de ahí el undefined/undefined en la UI).
  const isoDate = (v) => {
    if (v == null || v === '') return null;
    if (v instanceof Date) {
      if (isNaN(v.getTime())) return null;
      const y = v.getFullYear(), m = String(v.getMonth() + 1).padStart(2, '0'), d = String(v.getDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
    const mt = String(v).match(/\d{4}-\d{2}-\d{2}/);
    return mt ? mt[0] : null;
  };
  const numOrNull = (v) => (v === '' || v == null || isNaN(Number(v))) ? null : Number(v);
  const quienEs = (req) => (req.admin && (req.admin.usuario || (req.admin.maestro ? 'maestro' : ''))) || '';
  // Normaliza un SKU para comparar (mayúsculas, solo letras/números) — igual que el frontend.
  const cleanSku = (v) => String(v == null ? '' : v).normalize('NFKD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');

  // ── Logística tramo 2 (hub → Perú). Hub: miami | madrid | '' (directo a Perú).
  //    Llegada tentativa a Perú según el día que el paquete llega al HUB:
  //    MIAMI  (llegadas a Perú martes/viernes): Lun–Mié → próx. MARTES; Jue–Dom → próx. VIERNES.
  //    MADRID (llegadas a Perú lunes/miércoles): Lun–Mié → próx. MIÉRCOLES; Jue–Dom → próx. LUNES.
  const hoyISO = () => new Date().toISOString().slice(0, 10);
  const isISO = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
  function proximoDow(fromISO, dow) {             // próxima fecha con ese día de semana, ESTRICTAMENTE después
    const base = isISO(fromISO) ? new Date(fromISO + 'T00:00:00') : new Date();
    for (let i = 1; i <= 14; i++) { const x = new Date(base); x.setDate(base.getDate() + i); if (x.getDay() === dow) return x.toISOString().slice(0, 10); }
    return null;
  }
  function etaPeruDesdeHub(hub, fechaHubISO) {     // fecha tentativa de llegada a Perú
    if (!isISO(fechaHubISO) || !(hub === 'miami' || hub === 'madrid')) return null; // directo: sin cálculo
    const dw = new Date(fechaHubISO + 'T00:00:00').getDay(); // 0=Dom..6=Sáb
    let target;
    if (hub === 'miami') target = (dw >= 1 && dw <= 3) ? 2 /*Mar*/ : 5 /*Vie*/;
    else { target = (dw >= 1 && dw <= 3) ? 3 /*Mié*/ : 1 /*Lun*/; } // Madrid: Lun–Mié → miércoles; Jue–Dom → lunes
    return proximoDow(fechaHubISO, target);
  }
  const tokenRnd = () => (Date.now().toString(36) + Math.random().toString(36).slice(2, 12)).slice(0, 32);

  // ── Lectura del courier (tramo 1 origen→hub). Proveedor INTERCAMBIABLE:
  //    TRACK_PROVIDER = ship24 (por defecto) | 17track. Cada uno con su API key.
  //    Devuelve { numero: { estado, resumen, delivered, destPais } }. Autodetecta courier.
  const TRACK17_KEY = process.env.TRACK17_API_KEY || '';
  const SHIP24_KEY  = process.env.SHIP24_API_KEY || '';
  const TRACK_PROV  = (process.env.TRACK_PROVIDER || 'ship24').toLowerCase();
  const trackDisponible = () => !!(SHIP24_KEY || TRACK17_KEY);

  // Traducción al español de los estados/eventos del courier (vienen en inglés).
  const MILE_ES = { pending:'Pendiente', info_received:'Información recibida', in_transit:'En tránsito', out_for_delivery:'En reparto', failed_attempt:'Intento de entrega fallido', available_for_pickup:'Disponible para recojo', delivered:'Entregado', exception:'Incidencia', expired:'Vencido' };
  const COURIER_ES = [
    [/out for delivery/ig,'en reparto'], [/delivered/ig,'entregado'], [/in transit/ig,'en tránsito'],
    [/arrived at/ig,'llegó a'], [/departed from/ig,'salió de'], [/departed/ig,'salió de'],
    [/picked up/ig,'recogido'], [/customs clearance/ig,'despacho aduanero'], [/clearance/ig,'despacho aduanero'],
    [/customs/ig,'aduana'], [/processed/ig,'procesado'], [/processing/ig,'en proceso'],
    [/shipment information received|information received|info received|label created|shipping label created/ig,'información recibida'],
    [/available for pickup/ig,'disponible para recojo'], [/on hold|held/ig,'retenido'],
    [/exception|failed attempt/ig,'incidencia'], [/sort facility|sorting center|sorting|facility/ig,'centro de distribución'],
    [/warehouse/ig,'almacén'], [/origin/ig,'origen'], [/destination/ig,'destino'],
    [/your (item|package|parcel|shipment)/ig,'tu envío'], [/the (item|package|parcel|shipment)/ig,'el envío'],
    [/delivery/ig,'entrega'], [/returned/ig,'devuelto'], [/accepted/ig,'aceptado'], [/received/ig,'recibido'],
  ];
  function traducirCourier(t){ let x=String(t||''); COURIER_ES.forEach(p=>{ x=x.replace(p[0],p[1]); }); return x.slice(0,255); }
  function labelEstado(mile, resumen){ return MILE_ES[String(mile||'').toLowerCase()] || traducirCourier(resumen) || ''; }
  const fechaCorta = (v) => { const m=String(v||'').match(/\d{4}-\d{2}-\d{2}/); return m?m[0]:''; };

  async function ship24Consultar(numeros) {
    const out = {};
    if (!SHIP24_KEY) return out;
    const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SHIP24_KEY };
    for (const n of numeros.slice(0, 40)) {
      try {
        const r = await fetch('https://api.ship24.com/public/v1/trackers/track', { method: 'POST', headers, body: JSON.stringify({ trackingNumber: String(n) }) });
        const j = await r.json().catch(() => null);
        const tr = (j && j.data && j.data.trackings && j.data.trackings[0]) || null;
        if (!tr) continue;
        const sh = tr.shipment || {};
        const mile = s(sh.statusMilestone || '');
        // Eventos completos ordenados por fecha (más reciente primero), traducidos al español.
        const evsRaw = Array.isArray(tr.events) ? tr.events.slice() : [];
        evsRaw.sort((a, b) => String(b.occurrenceDatetime || '').localeCompare(String(a.occurrenceDatetime || '')));
        const eventos = evsRaw.map(ev => ({
          fecha: fechaCorta(ev.occurrenceDatetime || ev.datetime || ''),
          desc: traducirCourier([s(ev.status || ''), s(ev.location || '')].filter(Boolean).join(' · ')),
        })).filter(e => e.fecha || e.desc).slice(0, 60);
        const ev0 = evsRaw[0] || {};
        const resumen = (labelEstado(mile, ev0.status) || s(ev0.status || mile)).slice(0, 255);
        const delivered = mile === 'delivered';
        // Fecha de entrega real = fecha del evento "delivered" si existe.
        const evEntrega = evsRaw.find(e => s(e.statusMilestone || '') === 'delivered') || (delivered ? ev0 : null);
        const entrega = evEntrega ? fechaCorta(evEntrega.occurrenceDatetime || '') : '';
        const destPais = s(sh.destinationCountryCode || (sh.recipient && sh.recipient.countryCode) || '').toUpperCase().slice(0, 2);
        out[String(n)] = { estado: mile, resumen, delivered, destPais, eventos, entrega };
      } catch (e) { /* una falla no corta las demás */ }
    }
    return out;
  }
  async function track17Consultar(numeros) {
    const out = {};
    if (!TRACK17_KEY || !numeros.length) return out;
    const body = JSON.stringify(numeros.slice(0, 40).map(n => ({ number: String(n) })));
    const headers = { 'Content-Type': 'application/json', '17token': TRACK17_KEY };
    try {
      await fetch('https://api.17track.net/track/v2.2/register', { method: 'POST', headers, body }).catch(() => {});
      const r = await fetch('https://api.17track.net/track/v2.2/gettrackinfo', { method: 'POST', headers, body });
      const j = await r.json().catch(() => null);
      const acc = (j && j.data && j.data.accepted) || [];
      acc.forEach(it => {
        const num = String(it.number || '');
        const ti = it.track_info || {};
        const ls = (ti.latest_status || {}); const le = (ti.latest_event || {});
        const estado = s(ls.status || '').slice(0, 40);
        const delivered = /deliver/i.test(estado);
        // Eventos: en v2.2 vienen en tracking.providers[].events; fallback al último evento.
        let evsRaw = [];
        const prov = (ti.tracking && Array.isArray(ti.tracking.providers)) ? ti.tracking.providers : [];
        prov.forEach(p => { if (Array.isArray(p.events)) evsRaw = evsRaw.concat(p.events); });
        if (!evsRaw.length && le && (le.description || le.time_iso)) evsRaw = [le];
        evsRaw.sort((a, b) => String(b.time_iso || b.time_utc || '').localeCompare(String(a.time_iso || a.time_utc || '')));
        const eventos = evsRaw.map(ev => ({
          fecha: fechaCorta(ev.time_iso || ev.time_utc || ev.time_raw || ''),
          desc: traducirCourier([s(ev.description || ''), s(ev.location || '')].filter(Boolean).join(' · ')),
        })).filter(e => e.fecha || e.desc).slice(0, 60);
        const resumen = (traducirCourier(le.description || ls.sub_status) || estado).slice(0, 255);
        const evEntrega = evsRaw.find(e => /deliver/i.test(s(e.stage || e.sub_status || e.description || ''))) || (delivered ? evsRaw[0] : null);
        const entrega = evEntrega ? fechaCorta(evEntrega.time_iso || evEntrega.time_utc || '') : '';
        const destPais = s((ti.misc_info && (ti.misc_info.destination_country || ti.misc_info.destination_country_iso2)) || '').toUpperCase().slice(0, 2);
        if (num) out[num] = { estado, resumen, delivered, destPais, eventos, entrega };
      });
    } catch (e) { console.error('[seguimiento] 17track', e.message); }
    return out;
  }
  async function trackConsultar(numeros) {
    if (TRACK_PROV === '17track' && TRACK17_KEY) return track17Consultar(numeros);
    if (SHIP24_KEY) return ship24Consultar(numeros);
    if (TRACK17_KEY) return track17Consultar(numeros);
    return {};
  }
  const paisAHub = (p) => (p === 'US' ? 'miami' : (p === 'ES' ? 'madrid' : ''));

  // Imagen de referencia por SKU (del ERP, SOLO LECTURA). Igual criterio que el cotizador:
  // product_images.path es la URL completa; la de la variación manda, si no la del padre.
  async function imagenesPorSku(skus) {
    const out = {};
    const limpios = [...new Set((skus || []).map(x => s(x).trim()).filter(Boolean))];
    if (!limpios.length) return out;
    try {
      const [vs] = await prodPool.query(
        `SELECT TRIM(pv.sku) AS sku, pv.id AS vid, pv.product_id AS pid
           FROM product_variations pv WHERE TRIM(pv.sku) IN (?)`, [limpios]);
      if (!vs.length) return out;
      const vids = vs.map(v => v.vid), pids = [...new Set(vs.map(v => v.pid))];
      const imgVar = {}, imgProd = {};
      const [imgs] = await prodPool.query(
        `SELECT product_id, product_variation_id, path FROM product_images
          WHERE deleted_at IS NULL AND path IS NOT NULL AND path <> ''
            AND (product_variation_id IN (?) OR product_id IN (?))
          ORDER BY is_primary DESC, sort_order ASC, id ASC`, [vids, pids]);
      imgs.forEach(im => {
        if (im.product_variation_id != null) { if (!imgVar[im.product_variation_id]) imgVar[im.product_variation_id] = im.path; }
        else if (im.product_id != null && !imgProd[im.product_id]) imgProd[im.product_id] = im.path;
      });
      vs.forEach(v => { const img = imgVar[v.vid] || imgProd[v.pid] || ''; if (img) out[v.sku] = img; });
    } catch (e) { console.warn('[seguimiento] imágenes por sku:', e.message); }
    return out;
  }

  // Estado del envío EN PALABRAS DEL CLIENTE (sin datos internos).
  const HUB_LABEL = { miami: 'almacén de Miami (EE.UU.)', madrid: 'almacén de Madrid (España)' };
  function estadoClienteEnvio(e) {
    const hubTxt = HUB_LABEL[e.hub] || 'almacén internacional';
    const eta = isoDate(e.eta);
    if (e.estado === 'recibido' || e.fase === 'recibido') return { clave: 'recibido', texto: 'Recibido en Perú', eta };
    if (e.fase === 'embarcado') return { clave: 'embarcado', texto: 'En camino a Perú', eta };
    if (e.fase === 'en_hub') return { clave: 'en_hub', texto: 'En el ' + hubTxt + ', preparando el envío a Perú', eta };
    const ap = s(e.api_resumen);
    const dest = e.hub ? ('al ' + hubTxt) : 'a Perú';
    return { clave: 'transito', texto: 'En camino ' + dest + (ap ? (' · ' + ap) : ''), eta: null };
  }

  // Backorders EN VIVO del ERP (SOLO LECTURA). Se usa para traerlos y para sincronizar.
  async function erpBackorders() {
    const [rows] = await prodPool.query(`
      SELECT si.id AS sale_item_id, TRIM(pv.sku) AS sku,
             COALESCE(NULLIF(TRIM(pv.name),''), p.name) AS producto,
             s.code AS venta, s.created_at AS fecha, si.quantity AS cantidad,
             COALESCE(NULLIF(TRIM(cli.business_name),''),
                      NULLIF(TRIM(CONCAT_WS(' ', cli.first_name, cli.last_name)),''), '—') AS cliente
        FROM sale_items si
        JOIN sales s ON s.id = si.sale_id
        JOIN product_variations pv ON pv.id = si.product_variation_id
        JOIN products p ON p.id = pv.product_id
        LEFT JOIN parties cli ON cli.id = s.customer_id
       WHERE si.stock_batch_id IS NULL AND si.is_backorder = 1
         AND s.deleted_at IS NULL AND s.status <> 'cancelled'
       ORDER BY s.created_at DESC, pv.sku
       LIMIT 2000`);
    return rows.map(r => ({
      sale_item_id: String(r.sale_item_id),
      sku: r.sku || '', producto: r.producto || '', cliente: r.cliente || '—',
      venta: r.venta || '', cantidad: Number(r.cantidad) || 0,
      fecha: r.fecha ? String(r.fecha).slice(0, 10) : ''
    }));
  }

  // Referencias de las ENTRADAS del ERP (stock_entries.reference_number), donde
  // el usuario escribe el/los N° de factura al hacer el ingreso. SOLO LECTURA.
  //  Devuelve un Set de "tokens" normalizados (por si en una entrada juntan
  //  varios números separados por coma/espacio/;/|) más las cadenas completas.
  const normRef = (v) => String(v == null ? '' : v).trim().toUpperCase().replace(/\s+/g, '');
  async function erpReferencias() {
    const set = new Set();
    try {
      const [rows] = await prodPool.query(
        `SELECT reference_number FROM stock_entries
          WHERE reference_number IS NOT NULL AND reference_number <> ''
          ORDER BY id DESC LIMIT 5000`);
      rows.forEach(r => {
        const full = normRef(r.reference_number);
        if (full) set.add(full);
        // Partir por separadores comunes por si pusieron varias facturas juntas.
        String(r.reference_number).split(/[,;|]+/).forEach(p => { const t = normRef(p); if (t) set.add(t); });
      });
    } catch (e) { console.error('[seguimiento] erpReferencias', e.message); }
    return set;
  }
  // ¿El N° de factura del envío ya está registrado como entrada en el ERP?
  function facturaIngresada(nFactura, refSet, refArr) {
    const nf = normRef(nFactura);
    if (!nf || nf.length < 4) return false;
    if (refSet.has(nf)) return true;
    // Cobertura extra: alguna referencia CONTIENE el N° de factura (varias juntas
    // sin separador estándar). Se exige longitud >=4 para evitar falsos positivos.
    return refArr.some(ref => ref.includes(nf));
  }

  // ── Reparto global por CANTIDADES ─────────────────────────────────────────
  //  Recalcula desde cero cómo se cubren los backorders con los envíos:
  //   · Backorders activos, del más antiguo al más nuevo (una venta cada uno).
  //   · Envíos en orden de creación; cada ítem reparte su cantidad entre los
  //     backorders del MISMO SKU. Lo que no alcanza a cubrir ningún backorder
  //     queda como SOBRANTE del ítem.
  //  Escribe en cada backorder: cubierto + coberturas[{envio_id,tracking,cant,venta,cliente}].
  //  Escribe en cada ítem de envío: bo_alloc[{bo_id,venta,cliente,cant}] + sobra.
  async function recomputarCoberturas() {
    // Backorders activos, del MÁS ANTIGUO al más nuevo por fecha de venta (se
    // cubren primero los pedidos más viejos). Traemos también el estado actual
    // para escribir SOLO los que cambian (menos consultas = menos recursos).
    const [bo] = await portalPool.query(
      `SELECT id, sku, cantidad, venta, cliente, cubierto, coberturas, tracking
         FROM seg_bo_items WHERE archivado = 0 ORDER BY fecha ASC, creado_en ASC, id ASC`);
    const boSt = bo.map(r => ({
      id: r.id, k: cleanSku(r.sku), need: Number(r.cantidad) || 0, venta: r.venta || '', cliente: r.cliente || '',
      prevCub: Number(r.cubierto) || 0, prevCob: JSON.stringify(asJson(r.coberturas, []) || []), prevTrk: r.tracking || '', cob: []
    }));
    const porSku = {}; boSt.forEach(x => { (porSku[x.k] = porSku[x.k] || []).push(x); });

    const [envs] = await portalPool.query(`SELECT id, tracking, items FROM seg_envios WHERE archivado = 0 ORDER BY creado_en ASC, id ASC`);
    const updEnv = [];
    for (const ev of envs) {
      const items = asJson(ev.items, []) || [];
      const antes = JSON.stringify(items);
      items.forEach(it => {
        it.bo_alloc = []; it.bo_ids = []; it.sobra = 0;
        const k = cleanSku(it.sku); const q = Number(it.cantidad) || 0;
        if (!k || q <= 0) { it.sobra = q > 0 ? q : 0; return; }
        let avail = q;
        for (const bb of (porSku[k] || [])) {
          if (avail <= 0) break;
          const ya = bb.cob.reduce((sm, c) => sm + c.cant, 0);
          const falta = bb.need > 0 ? Math.max(0, bb.need - ya) : 0;
          const give = Math.min(avail, falta);
          if (give > 0) {
            bb.cob.push({ envio_id: ev.id, tracking: ev.tracking || '', cant: give, venta: bb.venta, cliente: bb.cliente });
            it.bo_alloc.push({ bo_id: bb.id, venta: bb.venta, cliente: bb.cliente, cant: give });
            it.bo_ids.push(bb.id);
            avail -= give;
          }
        }
        it.sobra = avail;
        it.es_backorder = it.bo_alloc.length > 0;
      });
      const despues = JSON.stringify(items);
      if (despues !== antes) updEnv.push({ id: ev.id, items: despues }); // solo si cambió
    }

    for (const bb of boSt) {
      const cubierto = bb.cob.reduce((sm, c) => sm + c.cant, 0);
      const cobStr = JSON.stringify(bb.cob);
      const trk = [...new Set(bb.cob.map(c => s(c.tracking)).filter(Boolean))].join(', ');
      if (cubierto === bb.prevCub && cobStr === bb.prevCob && trk === bb.prevTrk) continue; // sin cambios
      await portalPool.query(
        `UPDATE seg_bo_items SET coberturas = ?, cubierto = ?, tracking = ?, envio_id = ? WHERE id = ?`,
        [cobStr, cubierto, trk, (bb.cob.length ? bb.cob[0].envio_id : null), bb.id]);
    }
    for (const e of updEnv) {
      await portalPool.query(`UPDATE seg_envios SET items = ? WHERE id = ?`, [e.items, e.id]);
    }
  }

  // Normaliza una línea de ítem de envío (lo que manda el frontend ya resuelto).
  function itemEnvio(it) {
    it = it || {};
    return {
      codigo:    s(it.codigo).slice(0, 160),                    // código/n° parte de la factura
      desc:      s(it.desc).slice(0, 1000),                     // descripción original (idioma factura)
      desc_es:   s(it.desc_es).slice(0, 1000),                  // traducción al español (IA), completa
      marca:     s(it.marca).slice(0, 120),
      cantidad:  numOrNull(it.cantidad),
      sku:       s(it.sku).slice(0, 120),                       // SKU asignado en el sistema de ventas
      nombre:    s(it.nombre).slice(0, 255),                    // nombre del producto en el sistema
      confianza: s(it.confianza).slice(0, 20),                  // exact | alta | rev | no | manual
      es_backorder: !!it.es_backorder,                          // ¿cubre un producto en backorder?
      bo_ids:    Array.isArray(it.bo_ids) ? it.bo_ids.map(x => s(x).slice(0, 60)).filter(Boolean) : [],
      // Ajustes del ALMACÉN (solo en envíos que vienen de Importaciones):
      sku_factura: s(it.sku_factura).slice(0, 120),             // SKU sugerido en la factura, si el almacén lo cambió
      cant_factura: numOrNull(it.cant_factura),                 // cantidad facturada, si llegó otra
      verificado: !!it.verificado,                              // confirmado por el almacén
      no_llego:  !!it.no_llego,
      es_extra:  !!it.es_extra                                  // llegó sin estar en la factura
    };
  }

  // ── Envío ← confirmación del almacén ──────────────────────────────────────
  //  Parte SIEMPRE de las líneas originales (items_factura) para que se pueda
  //  repetir (reconfirmación, corrección) sin acumular cambios.
  //  · SKU     → el que confirmó el almacén (sku_factura guarda el de la factura).
  //  · Cantidad→ la que realmente llegó; 'no llegó' → 0.
  //  · Línea subdividida en varios SKU → una línea por SKU.
  //  · Productos fuera de factura → se agregan (también pueden cubrir backorders).
  function aplicarRecepcion(base, recItems, nombres) {
    const normCod = (x) => s(x).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    const recNo = recItems.filter(i => !i.es_extra);
    // Emparejar por posición si las listas coinciden; si no, por código (en orden).
    const mismoOrden = recNo.length === base.length && base.every((b, k) => normCod(b.codigo) === normCod(recNo[k].codigo));
    const colas = {};
    if (!mismoOrden) recNo.forEach(r => { const k = normCod(r.codigo); (colas[k] = colas[k] || []).push(r); });
    const nom = (sku, def) => (nombres && nombres.get(sku)) || def || '';
    const out = [];
    base.forEach((b, k) => {
      const r = mismoOrden ? recNo[k] : ((colas[normCod(b.codigo)] || []).shift() || null);
      if (!r) { out.push({ ...b }); return; }
      const cantFac = b.cantidad;
      if (r.estado_item === 'no_llego') {
        out.push({ ...b, cantidad: 0, cant_factura: cantFac, no_llego: true, verificado: true });
        return;
      }
      const recibida = (r.cant_recibida == null ? cantFac : Number(r.cant_recibida));
      if (Array.isArray(r.sub) && r.sub.length) {
        r.sub.forEach(sx => {
          const sku = s(sx.sku_confirmado) || b.sku;
          const cant = (r.split_modo === 'cant') ? (sx.cant_recibida == null ? 0 : Number(sx.cant_recibida)) : recibida;
          out.push({ ...b, sku, nombre: nom(sku, sku === b.sku ? b.nombre : ''), cantidad: cant,
            sku_factura: b.sku, cant_factura: cantFac, confianza: 'almacen', verificado: true });
        });
        return;
      }
      const sku = s(r.sku_confirmado) || b.sku;
      const cambio = sku !== b.sku;
      out.push({ ...b, sku, nombre: cambio ? nom(sku, '') : b.nombre, cantidad: recibida,
        sku_factura: cambio ? b.sku : '', cant_factura: (recibida !== cantFac ? cantFac : null),
        confianza: cambio ? 'almacen' : b.confianza, verificado: true });
    });
    recItems.filter(i => i.es_extra).forEach(r => {
      const sku = s(r.sku_confirmado);
      out.push({ codigo: s(r.codigo), desc: s(r.desc), desc_es: s(r.desc), marca: '', sku, nombre: nom(sku, ''),
        cantidad: numOrNull(r.cant_recibida), confianza: 'almacen', verificado: true, es_extra: true });
    });
    return out.map(itemEnvio);
  }

  // Llamado por Recepciones cuando el almacén confirma (o se corrige) una recepción.
  async function alConfirmarRecepcion(rec) {
    if (!rec) return;
    const ids = [...new Set([s(rec.id), s(rec.importacion_id)].filter(Boolean))];
    let [envs] = await portalPool.query(
      `SELECT id, items, items_factura, n_factura, proveedor FROM seg_envios
        WHERE origen = 'importacion' AND (recep_id IN (?) OR importacion_id IN (?)) LIMIT 1`, [ids, ids]);
    if (!envs.length && rec.n_factura) {
      // Respaldo: misma factura (normalizada) entre los envíos que vinieron de Importaciones.
      const nf = s(rec.n_factura).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      const [cand] = await portalPool.query(
        `SELECT id, items, items_factura, n_factura, proveedor FROM seg_envios WHERE origen = 'importacion' AND n_factura <> ''`);
      envs = cand.filter(e => s(e.n_factura).replace(/[^A-Za-z0-9]/g, '').toUpperCase() === nf);
      if (envs.length !== 1) return; // ambiguo o inexistente: no tocar nada
    }
    if (!envs.length) return;
    const ev = envs[0];
    const base = asJson(ev.items_factura, null) || asJson(ev.items, []) || [];
    const recItems = asJson(rec.items, []) || [];
    let nombres = null; try { nombres = await nombrePorSku(prodPool); } catch (e) { /* sin nombres nuevos */ }
    const items = aplicarRecepcion(base.filter(i => !i.es_extra), recItems, nombres);
    await portalPool.query(
      `UPDATE seg_envios SET items = ?, items_factura = COALESCE(items_factura, ?), recep_id = ?, recep_conf_at = NOW() WHERE id = ?`,
      [JSON.stringify(items), JSON.stringify(base), s(rec.id), ev.id]);
    await recomputarCoberturas();
  }

  // ════════════════════════════════════════════════════════════════════════
  //  LECTURA (supervisor + maestro)
  // ════════════════════════════════════════════════════════════════════════

  // ── Catálogo del sistema de ventas (solo lectura) → [[sku, name], ...] ─────
  //    Caché COMPARTIDA con Importaciones y Recepciones (comunes.js).
  app.get('/api/seguimiento/catalogo', authAdmin, mSeg, rutaCatalogo(prodPool, 'seguimiento'));

  // ── Envíos (con sus ítems) ─────────────────────────────────────────────────
  //    ?estado=en_transito|recibido para filtrar.
  app.get('/api/seguimiento/envios', authAdmin, mSeg, async (req, res) => {
    try {
      const w = [], args = [];
      if (req.query.estado) { w.push('estado = ?'); args.push(String(req.query.estado)); }
      if (!req.query.incluir_archivados) w.push('archivado = 0'); // por defecto ocultar los archivados
      let sql = `SELECT * FROM seg_envios` + (w.length ? ' WHERE ' + w.join(' AND ') : '') +
                ` ORDER BY (estado='recibido') ASC, actualizado_en DESC`;
      const [rows] = await portalPool.query(sql, args);
      const recEstado = await estadosRecepcion(rows);
      // El proveedor y el N° de factura SOLO los ve el maestro. Al supervisor ni
      // siquiera se le envían desde el servidor (no basta con ocultarlos en la UI).
      const esMaestro = !!(req.admin && req.admin.maestro);
      res.json(rows.map(r => ({
        id: r.id, tracking: r.tracking, courier: r.courier,
        proveedor: esMaestro ? r.proveedor : '', n_factura: r.n_factura,
        estado: r.estado, fecha_estimada: isoDate(r.fecha_estimada), archivado: r.archivado ? 1 : 0,
        hub: r.hub || '', fase: r.fase || 'transito',
        fecha_salida: isoDate(r.fecha_salida),
        fecha_hub: isoDate(r.fecha_hub),
        eta: isoDate(r.eta),
        api_resumen: r.api_resumen || '', api_estado: r.api_estado || '',
        api_at: r.api_at || null,
        api_eventos: asJson(r.api_eventos, []) || [],
        api_entrega: isoDate(r.api_entrega),
        nota: r.nota || '', items: asJson(r.items, []) || [],
        origen: r.origen || 'manual', importacion_id: r.importacion_id || '', codigo: r.codigo || '',
        recep_id: r.recep_id || '', recep_estado: recEstado[r.id] || '', recep_conf_at: r.recep_conf_at || null,
        creado_por: r.creado_por, creado_en: r.creado_en, actualizado_en: r.actualizado_en
      })));
    } catch (e) {
      console.error('[seguimiento] envios', e.message);
      res.status(500).json({ error: 'No se pudieron leer los envíos' });
    }
  });

  // Estado de la recepción ligada a cada envío (una sola consulta para todos).
  async function estadosRecepcion(rows) {
    const out = {};
    const porId = {};
    rows.forEach(r => {
      if (r.origen !== 'importacion') return;
      [s(r.recep_id), s(r.importacion_id)].filter(Boolean).forEach(k => { (porId[k] = porId[k] || []).push(r.id); });
    });
    const keys = Object.keys(porId);
    if (!keys.length) return out;
    try {
      const [recs] = await portalPool.query(
        `SELECT id, importacion_id, estado, archivada FROM imp_recepciones WHERE id IN (?) OR importacion_id IN (?)`, [keys, keys]);
      recs.forEach(rc => {
        const est = rc.archivada ? 'costeada' : rc.estado;
        [s(rc.id), s(rc.importacion_id)].forEach(k => (porId[k] || []).forEach(envId => { if (!out[envId]) out[envId] = est; }));
      });
    } catch (e) { /* si la tabla no existe aún, sin estado */ }
    return out;
  }

  app.get('/api/seguimiento/envio/:id', authAdmin, mSeg, async (req, res) => {
    try {
      const [rows] = await portalPool.query(`SELECT * FROM seg_envios WHERE id = ?`, [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: 'Envío no encontrado' });
      const r = rows[0];
      const esMaestro = !!(req.admin && req.admin.maestro);
      res.json({
        id: r.id, tracking: r.tracking, courier: r.courier,
        proveedor: esMaestro ? r.proveedor : '', n_factura: r.n_factura,
        estado: r.estado, fecha_estimada: r.fecha_estimada,
        nota: r.nota || '', items: asJson(r.items, []) || [],
        origen: r.origen || 'manual', importacion_id: r.importacion_id || '', recep_id: r.recep_id || '',
        creado_por: r.creado_por, creado_en: r.creado_en, actualizado_en: r.actualizado_en
      });
    } catch (e) {
      console.error('[seguimiento] envio', e.message);
      res.status(500).json({ error: 'No se pudo leer el envío' });
    }
  });

  // ── Grupos de backorder ────────────────────────────────────────────────────
  app.get('/api/seguimiento/grupos', authAdmin, mSeg, async (req, res) => {
    try {
      const [rows] = await portalPool.query(`SELECT * FROM seg_grupos ORDER BY orden ASC, creado_en ASC`);
      res.json(rows.map(g => ({
        id: g.id, nombre: g.nombre, vta: g.vta, cliente: g.cliente,
        precio_venta: g.precio_venta, precio_pagado: g.precio_pagado,
        nota: g.nota || '', orden: g.orden,
        creado_en: g.creado_en, actualizado_en: g.actualizado_en
      })));
    } catch (e) {
      console.error('[seguimiento] grupos', e.message);
      res.status(500).json({ error: 'No se pudieron leer los grupos' });
    }
  });

  // ── Ítems de backorder gestionados ─────────────────────────────────────────
  //    ?incluir_archivados=1 para ver también los archivados.
  app.get('/api/seguimiento/bo-items', authAdmin, mSeg, async (req, res) => {
    try {
      let sql = `SELECT * FROM seg_bo_items`;
      if (!req.query.incluir_archivados) sql += ` WHERE archivado = 0`;
      sql += ` ORDER BY fecha ASC, creado_en ASC`; // por fecha de la venta (más antigua primero)
      const [rows] = await portalPool.query(sql);
      res.json(rows.map(b => ({
        id: b.id, grupo_id: b.grupo_id || '', sku: b.sku, nombre: b.nombre,
        cliente: b.cliente, venta: b.venta, cantidad: b.cantidad,
        fecha: b.fecha ? String(b.fecha).slice(0, 10) : '',
        comprado: b.comprado ? 1 : 0, nota: b.nota || '', orden: b.orden,
        origen: b.origen, archivado: b.archivado ? 1 : 0,
        envio_id: b.envio_id || '', tracking: b.tracking || '',
        cubierto: Number(b.cubierto) || 0, coberturas: asJson(b.coberturas, []) || [],
        creado_en: b.creado_en, actualizado_en: b.actualizado_en
      })));
    } catch (e) {
      console.error('[seguimiento] bo-items', e.message);
      res.status(500).json({ error: 'No se pudieron leer los backorders' });
    }
  });

  // ── Resumen (para el badge y las tarjetas) ─────────────────────────────────
  app.get('/api/seguimiento/resumen', authAdmin, mSeg, async (req, res) => {
    try {
      const [[env]] = await portalPool.query(
        `SELECT SUM(estado='en_transito') AS en_transito, SUM(estado='recibido') AS recibido FROM seg_envios`);
      const [[bo]] = await portalPool.query(
        `SELECT SUM(comprado=0) AS sin_comprar, SUM(comprado=1) AS comprados FROM seg_bo_items WHERE archivado = 0`);
      res.json({
        en_transito: Number(env && env.en_transito) || 0,
        recibido: Number(env && env.recibido) || 0,
        bo_sin_comprar: Number(bo && bo.sin_comprar) || 0,
        bo_comprados: Number(bo && bo.comprados) || 0
      });
    } catch (e) { res.json({ en_transito: 0, recibido: 0, bo_sin_comprar: 0, bo_comprados: 0 }); }
  });

  // ════════════════════════════════════════════════════════════════════════
  //  ESCRITURA (solo maestro)
  // ════════════════════════════════════════════════════════════════════════

  // (La lectura de facturas con IA ya NO está aquí: la factura se sube una sola
  //  vez en Importaciones y se envía a este módulo con «Enviar a seguimiento».)

  // ── Backorders EN VIVO desde el ERP (para elegir cuáles gestionar) ─────────
  //    SOLO LECTURA. Igual que /api/importacion/backorders pero devuelve el id
  //    del sale_item para poder "fijarlo" en el portal sin perder su estado.
  app.get('/api/seguimiento/erp-backorders', authAdmin, mSeg, soloMaestroSeg, async (req, res) => {
    try { res.json(await erpBackorders()); }
    catch (e) {
      console.error('[seguimiento] erp-backorders', e.message);
      res.status(500).json({ error: 'No se pudieron leer los backorders del sistema' });
    }
  });

  // ── Sincronizar TODOS los backorders del ERP al portal (traerlos por defecto) ─
  //    Inserta los que aún no están fijados (INSERT IGNORE, conserva nota/grupo/
  //    comprado de los existentes). Devuelve cuántos nuevos entraron.
  app.post('/api/seguimiento/bo-items/sync', authAdmin, mSeg, soloMaestroSeg, async (req, res) => {
    try {
      // Throttle: la sincronización con el ERP es lo más caro. Si se pidió hace
      // poco y NO es forzada (botón "Actualizar"), no se vuelve a golpear el ERP.
      const forzar = !!(req.body && req.body.force) || !!req.query.force;
      if (!forzar && (Date.now() - _lastSyncSeg) < SYNC_TTL_SEG) {
        return res.json({ ok: true, throttled: true });
      }

      const lineas = await erpBackorders();
      // Inserta en UNA sola consulta. Para los que ya existen, REFRESCA solo los
      // campos descriptivos del ERP (sku, nombre del HIJO, cliente, venta, fecha)
      // — así los backorders viejos también muestran el nombre correcto — sin tocar
      // la gestión (grupo, nota, comprado, cobertura, archivado).
      let insertados = 0;
      if (lineas.length) {
        const valores = lineas.map(l => [
          'erp:' + l.sale_item_id, s(l.sku).slice(0,120), s(l.producto).slice(0,255), s(l.cliente).slice(0,255),
          s(l.venta).slice(0,120), numOrNull(l.cantidad),
          (l.fecha && /^\d{4}-\d{2}-\d{2}/.test(String(l.fecha))) ? String(l.fecha).slice(0,10) : null, 'erp'
        ]);
        const [r] = await portalPool.query(
          `INSERT INTO seg_bo_items (id, sku, nombre, cliente, venta, cantidad, fecha, origen) VALUES ?
           ON DUPLICATE KEY UPDATE sku=VALUES(sku), nombre=VALUES(nombre), cliente=VALUES(cliente),
             venta=VALUES(venta), cantidad=VALUES(cantidad), fecha=VALUES(fecha)`, [valores]);
        insertados = (r && r.affectedRows) || 0;
      }

      // ── ARCHIVADO AUTOMÁTICO (cuando ya se ingresó al ERP) ────────────────
      //  Un backorder del ERP que YA NO aparece en la lista de pendientes del
      //  sistema significa que su stock ya se ingresó → se archiva solo.
      //  Si reaparece (se vuelve a pedir), se desarchiva.
      const presentes = lineas.map(l => 'erp:' + l.sale_item_id);
      let archivadosBo = 0;
      if (presentes.length) {
        const [a] = await portalPool.query(
          `UPDATE seg_bo_items SET archivado = 1 WHERE origen = 'erp' AND archivado = 0 AND id NOT IN (?)`, [presentes]);
        archivadosBo = (a && a.affectedRows) || 0;
        await portalPool.query(
          `UPDATE seg_bo_items SET archivado = 0 WHERE origen = 'erp' AND archivado = 1 AND id IN (?)`, [presentes]);
      } else {
        const [a] = await portalPool.query(
          `UPDATE seg_bo_items SET archivado = 1 WHERE origen = 'erp' AND archivado = 0`);
        archivadosBo = (a && a.affectedRows) || 0;
      }

      // Recalcular el reparto por cantidades con el set de backorders ya actualizado.
      await recomputarCoberturas();

      //  Un ENVÍO se archiva solo cuando YA SE INGRESÓ AL ERP:
      //   (a) su N° de factura aparece en stock_entries.reference_number, o
      //   (b) todos los backorders que cubre ya se archivaron.
      //  La (a) cubre también los envíos que no tenían ningún backorder.
      let archivadosEnv = 0;
      const [envs] = await portalPool.query(`SELECT id, n_factura, items FROM seg_envios WHERE archivado = 0`);
      if (envs.length) {
        const [boAll] = await portalPool.query(`SELECT id, archivado FROM seg_bo_items`);
        const boArch = {}; boAll.forEach(b => { boArch[b.id] = !!b.archivado; });
        const refSet = await erpReferencias();
        const refArr = [...refSet];
        for (const ev of envs) {
          let archivar = facturaIngresada(ev.n_factura, refSet, refArr); // (a)
          if (!archivar) { // (b)
            const items = asJson(ev.items, []) || [];
            const ids = [];
            items.forEach(it => { if (Array.isArray(it.bo_ids)) it.bo_ids.forEach(x => ids.push(x)); });
            archivar = ids.length > 0 && ids.every(id => boArch[id]);
          }
          if (archivar) {
            await portalPool.query(`UPDATE seg_envios SET archivado = 1 WHERE id = ?`, [ev.id]);
            archivadosEnv++;
          }
        }
      }

      _lastSyncSeg = Date.now();
      res.json({ ok: true, insertados, total: lineas.length, archivados_backorders: archivadosBo, archivados_envios: archivadosEnv });
    } catch (e) {
      console.error('[seguimiento] sync backorders', e.message);
      res.status(500).json({ error: 'No se pudieron sincronizar los backorders' });
    }
  });

  // ── Fijar (importar) líneas de backorder del ERP al portal ─────────────────
  //    Body: { lineas:[{sale_item_id, sku, producto, cliente, venta, cantidad, fecha}] }
  //    Upsert por id 'erp:'+sale_item_id. Conserva grupo/nota/comprado si ya existía.
  app.post('/api/seguimiento/bo-items/importar', authAdmin, mSeg, soloMaestroSeg, async (req, res) => {
    try {
      const lineas = Array.isArray(req.body && req.body.lineas) ? req.body.lineas : [];
      if (!lineas.length) return res.json({ ok: true, insertados: 0 });
      let insertados = 0;
      for (const l of lineas) {
        const sid = s(l && l.sale_item_id).trim();
        if (!sid) continue;
        const id = 'erp:' + sid;
        // Solo inserta si no existe (para no pisar nota/grupo/comprado ya puestos).
        const [r] = await portalPool.query(
          `INSERT IGNORE INTO seg_bo_items (id, sku, nombre, cliente, venta, cantidad, fecha, origen)
           VALUES (?,?,?,?,?,?,?, 'erp')`,
          [id, s(l.sku).slice(0,120), s(l.producto).slice(0,255), s(l.cliente).slice(0,255),
           s(l.venta).slice(0,120), numOrNull(l.cantidad),
           (l.fecha && /^\d{4}-\d{2}-\d{2}/.test(String(l.fecha))) ? String(l.fecha).slice(0,10) : null]);
        if (r && r.affectedRows) insertados++;
      }
      res.json({ ok: true, insertados });
    } catch (e) {
      console.error('[seguimiento] importar backorders', e.message);
      res.status(500).json({ error: 'No se pudieron fijar los backorders' });
    }
  });

  // ── Crear/actualizar un ítem de backorder (editar gestión: grupo, nota, comprado, archivar) ──
  //    El SUPERVISOR también puede: agrupar, poner notas, marcar comprado y archivar.
  //    (Eliminar sigue siendo solo del maestro.)
  app.post('/api/seguimiento/bo-item', authAdmin, mSeg, async (req, res) => {
    try {
      const b = req.body || {};
      const id = s(b.id).trim() || ('man:' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7));
      const origen = id.startsWith('erp:') ? 'erp' : 'manual';
      await portalPool.query(
        `INSERT INTO seg_bo_items (id, grupo_id, sku, nombre, cliente, venta, cantidad, fecha, comprado, nota, orden, origen, archivado)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE grupo_id=VALUES(grupo_id), sku=VALUES(sku), nombre=VALUES(nombre),
           cliente=VALUES(cliente), venta=VALUES(venta), cantidad=VALUES(cantidad), fecha=VALUES(fecha),
           comprado=VALUES(comprado), nota=VALUES(nota), orden=VALUES(orden), archivado=VALUES(archivado)`,
        [id, s(b.grupo_id).trim() || null, s(b.sku).slice(0,120), s(b.nombre).slice(0,255),
         s(b.cliente).slice(0,255), s(b.venta).slice(0,120), numOrNull(b.cantidad),
         (b.fecha && /^\d{4}-\d{2}-\d{2}/.test(String(b.fecha))) ? String(b.fecha).slice(0,10) : null,
         b.comprado ? 1 : 0, s(b.nota).slice(0, 2000), +b.orden || 0, origen, b.archivado ? 1 : 0]);
      res.json({ ok: true, id });
    } catch (e) {
      console.error('[seguimiento] bo-item', e.message);
      res.status(500).json({ error: 'No se pudo guardar el backorder' });
    }
  });

  app.delete('/api/seguimiento/bo-item/:id', authAdmin, mSeg, soloMaestroSeg, async (req, res) => {
    try {
      await portalPool.query(`DELETE FROM seg_bo_items WHERE id = ?`, [req.params.id]);
      res.json({ ok: true });
    } catch (e) {
      console.error('[seguimiento] del bo-item', e.message);
      res.status(500).json({ error: 'No se pudo eliminar' });
    }
  });

  // ── Crear/actualizar un grupo (el supervisor también puede agrupar) ────────
  app.post('/api/seguimiento/grupo', authAdmin, mSeg, async (req, res) => {
    try {
      const b = req.body || {};
      const id = s(b.id).trim() || ('grp:' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7));
      await portalPool.query(
        `INSERT INTO seg_grupos (id, nombre, vta, cliente, precio_venta, precio_pagado, nota, orden)
         VALUES (?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE nombre=VALUES(nombre), vta=VALUES(vta), cliente=VALUES(cliente),
           precio_venta=VALUES(precio_venta), precio_pagado=VALUES(precio_pagado), nota=VALUES(nota), orden=VALUES(orden)`,
        [id, s(b.nombre).slice(0,200), s(b.vta).slice(0,120), s(b.cliente).slice(0,255),
         numOrNull(b.precio_venta), numOrNull(b.precio_pagado), s(b.nota).slice(0, 2000), +b.orden || 0]);
      res.json({ ok: true, id });
    } catch (e) {
      console.error('[seguimiento] grupo', e.message);
      res.status(500).json({ error: 'No se pudo guardar el grupo' });
    }
  });

  // ── Eliminar un grupo (sus ítems quedan sin grupo, no se borran) ───────────
  app.delete('/api/seguimiento/grupo/:id', authAdmin, mSeg, soloMaestroSeg, async (req, res) => {
    try {
      await portalPool.query(`UPDATE seg_bo_items SET grupo_id = NULL WHERE grupo_id = ?`, [req.params.id]);
      await portalPool.query(`DELETE FROM seg_grupos WHERE id = ?`, [req.params.id]);
      res.json({ ok: true });
    } catch (e) {
      console.error('[seguimiento] del grupo', e.message);
      res.status(500).json({ error: 'No se pudo eliminar el grupo' });
    }
  });

  // ── Crear/actualizar un envío (tracking + ítems leídos de la factura) ──────
  app.post('/api/seguimiento/envio', authAdmin, mSeg, soloMaestroSeg, async (req, res) => {
    try {
      const b = req.body || {};
      const id = s(b.id).trim() || ('env:' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7));
      const items = Array.isArray(b.items) ? b.items.map(itemEnvio) : [];
      const tracking = s(b.tracking).slice(0, 160);

      // ¿Ya existía? conservar creado_por.
      const [prev] = await portalPool.query(`SELECT creado_por, origen FROM seg_envios WHERE id = ?`, [id]);
      // Envío que vino de Importaciones: sus líneas, proveedor y factura son de
      // SOLO LECTURA aquí (se corrigen en Importaciones y se reenvían). Solo se
      // edita tracking, courier, llegada estimada y nota; el estado no se toca.
      if (prev.length && prev[0].origen === 'importacion') {
        await portalPool.query(
          `UPDATE seg_envios SET tracking=?, courier=?, fecha_estimada=?, nota=? WHERE id=?`,
          [tracking, s(b.courier).slice(0,80),
           (b.fecha_estimada && /^\d{4}-\d{2}-\d{2}/.test(String(b.fecha_estimada))) ? String(b.fecha_estimada).slice(0,10) : null,
           s(b.nota).slice(0, 2000), id]);
        return res.json({ ok: true, id });
      }
      const creadoPor = (prev.length && prev[0].creado_por) ? prev[0].creado_por : quienEs(req);
      await portalPool.query(
        `INSERT INTO seg_envios (id, tracking, courier, proveedor, n_factura, estado, fecha_estimada, nota, items, creado_por)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE tracking=VALUES(tracking), courier=VALUES(courier), proveedor=VALUES(proveedor),
           n_factura=VALUES(n_factura), estado=VALUES(estado), fecha_estimada=VALUES(fecha_estimada),
           nota=VALUES(nota), items=VALUES(items)`,
        [id, tracking, s(b.courier).slice(0,80), s(b.proveedor).slice(0,255),
         s(b.n_factura).slice(0,160), (b.estado === 'recibido' ? 'recibido' : 'en_transito'),
         (b.fecha_estimada && /^\d{4}-\d{2}-\d{2}/.test(String(b.fecha_estimada))) ? String(b.fecha_estimada).slice(0,10) : null,
         s(b.nota).slice(0, 2000), JSON.stringify(items), creadoPor]);

      // Recalcular TODO el reparto por cantidades (deja cada backorder con su
      // cobertura y cada ítem de envío con su desglose y sobrante).
      await recomputarCoberturas();
      res.json({ ok: true, id });
    } catch (e) {
      console.error('[seguimiento] envio guardar', e.message);
      res.status(500).json({ error: 'No se pudo guardar el envío' });
    }
  });

  // ── Crear/actualizar el envío DESDE IMPORTACIONES (Factura → SKU) ──────────
  //    Body: { importacion_id, codigo, proveedor, empresa, n_factura,
  //            items:[{codigo,desc,desc_es,marca,cantidad,sku,nombre,confianza}] }
  //    SIN precios (no se aceptan aunque vengan). Un envío por importacion_id:
  //    reenviar la misma factura ACTUALIZA sus líneas y conserva tracking y
  //    logística. Si ya existía un envío viejo (subido aquí) con la MISMA
  //    factura y sin vínculo, se adopta en vez de duplicarlo.
  app.post('/api/seguimiento/desde-importacion', authAdmin, mSeg, soloMaestroSeg, async (req, res) => {
    try {
      const b = req.body || {};
      const impId = s(b.importacion_id).trim().slice(0, 80);
      if (!impId) return res.status(400).json({ error: 'Falta el id de la importación' });
      const items = (Array.isArray(b.items) ? b.items : []).map(it => itemEnvio({
        codigo: it && it.codigo, desc: it && it.desc, desc_es: it && it.desc_es, marca: it && it.marca,
        cantidad: it && it.cantidad, sku: it && it.sku, nombre: it && it.nombre, confianza: it && it.confianza
      }));
      if (!items.length) return res.status(400).json({ error: 'La factura no tiene líneas' });
      const nFac = s(b.n_factura).slice(0, 160);

      let [prev] = await portalPool.query(
        `SELECT id, tracking, recep_conf_at FROM seg_envios WHERE importacion_id = ? LIMIT 1`, [impId]);
      if (!prev.length && nFac) {
        const nf = nFac.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
        const [cand] = await portalPool.query(
          `SELECT id, tracking, recep_conf_at, n_factura FROM seg_envios
            WHERE importacion_id = '' AND archivado = 0 AND n_factura <> ''`);
        const hits = cand.filter(e => s(e.n_factura).replace(/[^A-Za-z0-9]/g, '').toUpperCase() === nf);
        if (hits.length === 1) prev = hits;
      }
      if (prev.length && prev[0].recep_conf_at) {
        return res.status(409).json({ error: 'El almacén ya confirmó este envío; los cambios de SKU se hacen en la recepción (corrección).' });
      }
      const itemsJson = JSON.stringify(items);
      let id, nuevo = false;
      if (prev.length) {
        id = prev[0].id;
        await portalPool.query(
          `UPDATE seg_envios SET origen='importacion', importacion_id=?, codigo=?, proveedor=?, empresa=?, n_factura=?,
             items=?, items_factura=? WHERE id=?`,
          [impId, s(b.codigo).slice(0, 80), s(b.proveedor).slice(0, 255), s(b.empresa).slice(0, 255), nFac,
           itemsJson, itemsJson, id]);
      } else {
        id = 'env:' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
        nuevo = true;
        await portalPool.query(
          `INSERT INTO seg_envios (id, tracking, courier, proveedor, n_factura, estado, nota, items, creado_por,
             origen, importacion_id, codigo, empresa, items_factura)
           VALUES (?, '', '', ?, ?, 'en_transito', '', ?, ?, 'importacion', ?, ?, ?, ?)`,
          [id, s(b.proveedor).slice(0, 255), nFac, itemsJson, quienEs(req),
           impId, s(b.codigo).slice(0, 80), s(b.empresa).slice(0, 255), itemsJson]);
      }
      await recomputarCoberturas();
      res.json({ ok: true, id, nuevo, tracking: prev.length ? (prev[0].tracking || '') : '' });
    } catch (e) {
      console.error('[seguimiento] desde-importacion', e.message);
      res.status(500).json({ error: 'No se pudo crear el envío en Seguimiento' });
    }
  });

  // ── «Enviar a almacén» desde el envío (cuando llegó) ──────────────────────
  //    Crea (o actualiza, si aún no la validan) la recepción con las líneas del
  //    envío, SIN precios. Usa el mismo id que la importación, así Importación
  //    la encuentra y «Continuar a la DUA» retoma el costeo guardado.
  app.post('/api/seguimiento/envio/:id/a-almacen', authAdmin, mSeg, soloMaestroSeg, async (req, res) => {
    try {
      if (!recepciones || typeof recepciones.crearOActualizar !== 'function')
        return res.status(500).json({ error: 'El módulo de recepciones no está disponible' });
      const [rows] = await portalPool.query(`SELECT * FROM seg_envios WHERE id = ?`, [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: 'Envío no encontrado' });
      const ev = rows[0];
      if (ev.origen !== 'importacion' || !ev.importacion_id)
        return res.status(400).json({ error: 'Este envío no viene de Importaciones; envíalo al almacén desde Importaciones.' });
      const lineas = (asJson(ev.items_factura, null) || asJson(ev.items, []) || []).filter(i => !i.es_extra);
      const r = await recepciones.crearOActualizar({
        id: ev.importacion_id, importacion_id: ev.importacion_id, codigo: ev.codigo || ev.importacion_id,
        proveedor: ev.proveedor, empresa: ev.empresa, n_factura: ev.n_factura, tipo: 'compra',
        items: lineas.map(i => ({ codigo: i.codigo, desc: i.desc_es || i.desc, cantidad: i.cantidad,
          sku_sugerido: i.sku, confianza: i.confianza }))
      }, { buscarPorFactura: true });
      if (r.status !== 200) return res.status(r.status).json(r.body);
      await portalPool.query(
        `UPDATE seg_envios SET recep_id = ?, estado = 'recibido' WHERE id = ?`, [r.body.id, ev.id]);
      res.json({ ok: true, recep_id: r.body.id, nueva: !!r.body.nueva });
    } catch (e) {
      console.error('[seguimiento] a-almacen', e.message);
      res.status(500).json({ error: 'No se pudo enviar al almacén' });
    }
  });

  // ── Cambiar estado del envío (en_transito ↔ recibido) ──────────────────────
  app.put('/api/seguimiento/envio/:id/estado', authAdmin, mSeg, soloMaestroSeg, async (req, res) => {
    try {
      const estado = (req.body && req.body.estado === 'recibido') ? 'recibido' : 'en_transito';
      await portalPool.query(`UPDATE seg_envios SET estado = ? WHERE id = ?`, [estado, req.params.id]);
      res.json({ ok: true, estado });
    } catch (e) {
      console.error('[seguimiento] envio estado', e.message);
      res.status(500).json({ error: 'No se pudo cambiar el estado' });
    }
  });

  // ── Logística del envío: hub (miami|madrid|'' directo), fase y ETA (maestro) ─
  //    hub vacío = va directo a Perú (sin tramo intermedio, se guía por el courier).
  //    El ETA a Perú se calcula de la FECHA EN QUE LLEGA AL HUB (regla martes/viernes
  //    para Miami, lunes/miércoles para Madrid). No hay botón "recibido": eso lo
  //    cubre marcar el envío como recibido.
  app.put('/api/seguimiento/envio/:id/logistica', authAdmin, mSeg, soloMaestroSeg, async (req, res) => {
    try {
      const b = req.body || {};
      const hub = ['miami', 'madrid'].includes(s(b.hub)) ? s(b.hub) : '';
      const fase = ['transito', 'en_hub', 'embarcado'].includes(s(b.fase)) ? s(b.fase) : 'transito';
      let fhub = isISO(b.fecha_hub) ? String(b.fecha_hub).slice(0, 10) : null;
      let eta = null;
      if (fase === 'en_hub' || fase === 'embarcado') {
        if (!fhub) fhub = hoyISO();                 // si no se indicó, asumir que llegó al hub hoy
        eta = etaPeruDesdeHub(hub, fhub);
      } else { fhub = null; }
      await portalPool.query(
        `UPDATE seg_envios SET hub=?, fase=?, fecha_hub=?, eta=? WHERE id=?`,
        [hub, fase, fhub, eta, req.params.id]);
      res.json({ ok: true, hub, fase, fecha_hub: fhub, eta });
    } catch (e) {
      console.error('[seguimiento] logistica', e.message);
      res.status(500).json({ error: 'No se pudo guardar la logística' });
    }
  });

  // ── Actualizar estado del courier (tramo 1) — throttle 3 días ──────────────
  //    Lee el courier (Ship24/17track) y de paso: autodetecta el hub por país de
  //    destino, y si el courier dice "entregado" marca solo "en almacén" (en_hub)
  //    calculando el ETA a Perú. Sin API configurada → modo manual.
  let _lastTrack = 0; const TRACK_TTL = 3 * 24 * 60 * 60 * 1000;
  app.post('/api/seguimiento/track-refresh', authAdmin, mSeg, soloMaestroSeg, async (req, res) => {
    try {
      if (!trackDisponible()) return res.json({ ok: true, api: false, msg: 'Sin API de tracking configurada (modo manual).' });
      const forzar = !!(req.body && req.body.force);
      if (!forzar && (Date.now() - _lastTrack) < TRACK_TTL) return res.json({ ok: true, api: true, throttled: true });
      // Envíos aún en tramo 1 (en tránsito al hub) con número de tracking.
      const [rows] = await portalPool.query(
        `SELECT id, tracking, hub, fase FROM seg_envios WHERE archivado = 0 AND fase = 'transito' AND tracking <> ''`);
      const nums = [...new Set(rows.map(r => s(r.tracking)).filter(Boolean))];
      const info = await trackConsultar(nums);
      let n = 0, avanzados = 0;
      for (const r of rows) {
        const d = info[s(r.tracking)];
        if (!d) continue;
        let hub = s(r.hub);
        if (!hub && d.destPais) hub = paisAHub(d.destPais);        // autodetectar hub por país destino
        const evJSON = JSON.stringify(Array.isArray(d.eventos) ? d.eventos : []);
        const entrega = d.entrega || null;
        if (d.delivered && hub) {                                   // llegó al hub → marcar en almacén + ETA
          const fhub = d.entrega || hoyISO();                       // usar la fecha real de entrega del courier si existe
          const eta = etaPeruDesdeHub(hub, fhub);
          await portalPool.query(
            `UPDATE seg_envios SET api_estado=?, api_resumen=?, api_at=NOW(), api_eventos=?, api_entrega=?, hub=?, fase='en_hub', fecha_hub=?, eta=? WHERE id=?`,
            [d.estado, d.resumen, evJSON, entrega, hub, fhub, eta, r.id]);
          avanzados++;
        } else {
          await portalPool.query(
            `UPDATE seg_envios SET api_estado=?, api_resumen=?, api_at=NOW(), api_eventos=?, api_entrega=?, hub=? WHERE id=?`,
            [d.estado, d.resumen, evJSON, entrega, hub, r.id]);
        }
        n++;
      }
      _lastTrack = Date.now();
      res.json({ ok: true, api: true, actualizados: n, total: nums.length, a_almacen: avanzados });
    } catch (e) {
      console.error('[seguimiento] track-refresh', e.message);
      res.status(500).json({ error: 'No se pudo actualizar el tracking' });
    }
  });

  // ── Link de seguimiento público por CLIENTE (lo genera el maestro) ─────────
  app.get('/api/seguimiento/cliente-link', authAdmin, mSeg, async (req, res) => {
    try {
      const cliente = s(req.query.cliente).trim();
      if (!cliente) return res.status(400).json({ error: 'Falta el cliente' });
      const [ex] = await portalPool.query(`SELECT token FROM seg_cliente_token WHERE cliente = ? LIMIT 1`, [cliente]);
      let token = ex.length ? ex[0].token : tokenRnd();
      if (!ex.length) await portalPool.query(`INSERT INTO seg_cliente_token (token, cliente) VALUES (?,?)`, [token, cliente]);
      res.json({ ok: true, token, cliente, path: '/seguimiento-cliente.html?t=' + encodeURIComponent(token) });
    } catch (e) {
      console.error('[seguimiento] cliente-link', e.message);
      res.status(500).json({ error: 'No se pudo generar el link' });
    }
  });

  // ── PÚBLICO (SIN login): el cliente ve el estado de SU pedido por su token ──
  app.get('/api/seg-publico/:token', async (req, res) => {
    try {
      const [t] = await portalPool.query(`SELECT cliente FROM seg_cliente_token WHERE token = ? LIMIT 1`, [req.params.token]);
      if (!t.length) return res.status(404).json({ error: 'Enlace no válido' });
      const cliente = t[0].cliente;
      const [bo] = await portalPool.query(
        `SELECT sku, nombre AS producto, cantidad, cubierto, coberturas FROM seg_bo_items
          WHERE cliente = ? AND archivado = 0 ORDER BY fecha ASC, creado_en ASC`, [cliente]);
      const imgMap = await imagenesPorSku(bo.map(b => b.sku));
      const envioIds = new Set();
      bo.forEach(b => { (asJson(b.coberturas, []) || []).forEach(c => { if (c && c.envio_id) envioIds.add(c.envio_id); }); });
      const envMap = {};
      if (envioIds.size) {
        const [envs] = await portalPool.query(
          `SELECT id, hub, fase, estado, eta, api_resumen, api_at, actualizado_en FROM seg_envios WHERE id IN (?)`, [[...envioIds]]);
        envs.forEach(e => { envMap[e.id] = e; });
      }
      let ultima = null;
      const items = bo.map(b => {
        const cob = asJson(b.coberturas, []) || [];
        const prim = cob.find(c => c && c.envio_id && envMap[c.envio_id]);
        let estado = 'En proceso de compra', eta = null;
        if (prim) {
          const e = envMap[prim.envio_id];
          const info = estadoClienteEnvio(e);
          estado = info.texto; eta = info.eta;
          const at = e.api_at || e.actualizado_en;
          if (at && (!ultima || at > ultima)) ultima = at;
        }
        const imagen = imgMap[s(b.sku).trim()] || '';
        return { producto: b.producto || '', cantidad: b.cantidad, estado, eta, imagen };
      });
      res.json({ ok: true, cliente, items, actualizado: ultima, nota: 'Este seguimiento se actualiza cada 3 días.' });
    } catch (e) {
      console.error('[seguimiento] publico', e.message);
      res.status(500).json({ error: 'No se pudo cargar el seguimiento' });
    }
  });

  // ── Archivar / desarchivar un envío (cuando ya se ingresó al ERP) ──────────
  //    Disponible para el maestro y el supervisor. ?deshacer=1 lo desarchiva.
  app.put('/api/seguimiento/envio/:id/archivar', authAdmin, mSeg, async (req, res) => {
    try {
      const val = req.query.deshacer ? 0 : 1;
      await portalPool.query(`UPDATE seg_envios SET archivado = ? WHERE id = ?`, [val, req.params.id]);
      res.json({ ok: true, archivado: val });
    } catch (e) {
      console.error('[seguimiento] archivar envio', e.message);
      res.status(500).json({ error: 'No se pudo archivar el envío' });
    }
  });

  // ── Eliminar un envío ──────────────────────────────────────────────────────
  app.delete('/api/seguimiento/envio/:id', authAdmin, mSeg, soloMaestroSeg, async (req, res) => {
    try {
      await portalPool.query(`DELETE FROM seg_envios WHERE id = ?`, [req.params.id]);
      await recomputarCoberturas(); // recalcular el reparto sin este envío
      res.json({ ok: true });
    } catch (e) {
      console.error('[seguimiento] del envio', e.message);
      res.status(500).json({ error: 'No se pudo eliminar el envío' });
    }
  });

  return { prepararTablas, alConfirmarRecepcion, _test: { aplicarRecepcion } };
};
