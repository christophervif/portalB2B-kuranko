// ═══════════════════════════════════════════════════════════════════════════
//  MÓDULO: Precio oferta y STOCK EN VIVO en la web (WooCommerce) — solo SKUs en campaña
//  Parte de Promociones.
//
//  Qué hace
//   · Cada PROMO_WEB_MIN minutos (por defecto 2), y unos segundos después de que una
//     campaña escribe un precio en el ERP, compara el sale_price y el stock del ERP con
//     lo último subido a la web. Si cambió (oferta ≥ S/ 0.01 o cualquier unidad de
//     stock), lo sube a WooCommerce en el producto simple o la variación:
//       sale_price  ·  manage_stock + stock_quantity + stock_status
//     El stock se calcula IGUAL que el puente: suma de location_stocks.quantity de
//     todas las ubicaciones; stock_status instock si > 0, si no outofstock.
//   · Solo SKUs en campaña: los que están en una campaña ACTIVA (estado activo o
//     conflicto). Cuando un SKU sale de la campaña (fin, "Terminar ahora", sale por
//     lote o margen), se sube UNA vez más la oferta que quedó en el ERP (la original
//     devuelta) y se deja de seguir.
//   · Antes de escribir lee el producto en la web y compara el SKU: si no coincide
//     con el del ERP, no escribe (queda como "SKU distinto").
//   · No toca precio regular ni nada más. No crea ni borra productos.
//
//  Convivencia con el puente de las 2 AM (repo sync-stock-kuranko)
//   · El puente no manda sale_price salvo en tandas manuales con "actualizar oferta",
//     y en ese caso manda el mismo valor del ERP. No se pisan.
//   · El stock usa la misma fórmula que el puente, así que a las 2 AM manda el mismo valor.
//   · Al subir se actualiza también sync_estado (ultimo_stock, ultima_oferta: memoria del
//     puente), así el puente no repite lo que ya se subió.
//
//  Variables de entorno (las mismas del puente):
//   WC_URL, WC_CONSUMER_KEY, WC_CONSUMER_SECRET  → sin ellas el módulo queda apagado.
//   PROMO_WEB=false          → apagarlo sin quitar las claves.
//   PROMO_WEB_MIN            → minutos entre revisiones (por defecto 2).
//   PROMO_WEB_DRY_RUN=true   → solo simula (escribe en el log del servidor, no en la web).
//
//  Tabla (base del portal): promo_web — memoria de lo que hay en la web por SKU.
// ═══════════════════════════════════════════════════════════════════════════

const CADA_MIN = Math.max(1, Number(process.env.PROMO_WEB_MIN || 2));
const PAUSA_MS = 800;                 // entre escrituras: suave con el hosting compartido
const MAX_POR_VUELTA = 150;           // el resto queda para la siguiente vuelta
const REINTENTO_MIN = 60;             // un error con el mismo valor se reintenta a la hora

const aNum = v => (v == null || v === '' || !(Number(v) > 0)) ? null : Math.round(Number(v) * 100) / 100;
const igual = (a, b) => (a == null || b == null) ? a == null && b == null : Math.abs(a - b) < 0.005;
const pausa = ms => new Promise(r => setTimeout(r, ms));
const txt = v => v == null ? 'vacía' : 'S/ ' + v;

module.exports = function registrarOfertaWeb({ prodPool, portalPool }) {
  const WC_URL = String(process.env.WC_URL || '').trim().replace(/\/+$/, '');
  const KEY = process.env.WC_CONSUMER_KEY, SECRET = process.env.WC_CONSUMER_SECRET;
  const DRY = process.env.PROMO_WEB_DRY_RUN === 'true';
  const activo = !!(WC_URL && KEY && SECRET) && process.env.PROMO_WEB !== 'false' && typeof fetch === 'function';
  const AUTH = 'Basic ' + Buffer.from(`${KEY}:${SECRET}`).toString('base64');

  async function wc(metodo, ruta, cuerpo) {
    const r = await fetch(`${WC_URL}/wp-json/wc/v3${ruta}`, {
      method: metodo, signal: AbortSignal.timeout(30e3),
      headers: { Authorization: AUTH, 'Content-Type': 'application/json' },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined
    });
    const d = await r.json().catch(() => null);
    if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}${d && d.message ? ' ' + d.message : ''}`.slice(0, 200)), { status: r.status });
    return d;
  }

  let listo = false;
  async function prepararTablas() {
    await portalPool.query(`CREATE TABLE IF NOT EXISTS promo_web (
      vid INT PRIMARY KEY, sku VARCHAR(120), wc_id INT NULL, wc_padre INT NULL,
      oferta_web DECIMAL(12,2) NULL,              -- lo último que quedó en la web
      seguir TINYINT NOT NULL DEFAULT 1,          -- 1 = en campaña o falta subir el último cambio
      estado VARCHAR(15) NOT NULL DEFAULT 'nuevo', -- nuevo|ok|error|sin_id|sku_distinto
      oferta_intento DECIMAL(12,2) NULL, nota VARCHAR(300),
      intento_en DATETIME NULL, subido_en DATETIME NULL, INDEX (seguir))`);
    for (const c of ['stock_web INT NULL', 'stock_intento INT NULL'])          // agregadas después (stock en vivo)
      await portalPool.query(`ALTER TABLE promo_web ADD COLUMN ${c}`).catch(() => {});
    listo = true;
    if (!activo) { console.warn('[promo-web] Apagado: faltan WC_URL / WC_CONSUMER_KEY / WC_CONSUMER_SECRET (o PROMO_WEB=false).'); return; }
    console.log(`[promo-web] Precio oferta y stock en vivo: cada ${CADA_MIN} min${DRY ? ' (SIMULACIÓN)' : ''}.`);
    setInterval(() => revisar().catch(e => console.warn('[promo-web]', e.message)), CADA_MIN * 60e3);
    setTimeout(() => revisar().catch(e => console.warn('[promo-web]', e.message)), 45e3);
  }

  // Aviso desde las campañas: "acabo de escribir un precio" → revisar en unos segundos
  let timer = null;
  function avisar() {
    if (!activo || !listo) return;
    clearTimeout(timer);
    timer = setTimeout(() => revisar().catch(e => console.warn('[promo-web]', e.message)), 5e3);
  }

  let corriendo = false, otraVez = false, ultima = null;
  async function revisar() {
    if (!activo || !listo) return;
    if (corriendo) { otraVez = true; return; }
    corriendo = true;
    try { do { otraVez = false; ultima = await vuelta(); } while (otraVez); }
    finally { corriendo = false; }
  }

  async function vuelta() {
    const res = { en: new Date().toISOString(), revisados: 0, subidos: 0, sin_cambio: 0, errores: 0 };
    // 1) SKUs en campaña activa (y la campaña, para el historial)
    const [enC] = await portalPool.query(`SELECT i.vid, MAX(i.campana_id) AS cid FROM promo_items i
      JOIN promo_campanas c ON c.id = i.campana_id
      WHERE c.estado = 'activa' AND i.estado IN ('activo','conflicto') GROUP BY i.vid`);
    const campanaDe = new Map(enC.map(r => [Number(r.vid), r.cid]));
    // 2) Memoria: los que se siguen (en campaña o con un último cambio por subir)
    const [mem] = await portalPool.query(`SELECT * FROM promo_web WHERE seguir = 1 OR vid IN (?)`, [enC.length ? [...campanaDe.keys()] : [0]]);
    const M = new Map(mem.map(m => [Number(m.vid), m]));
    const vids = [...new Set([...campanaDe.keys(), ...mem.filter(m => m.seguir).map(m => Number(m.vid))])];
    if (!vids.length) return res;
    // 3) Datos del ERP (solo lectura)
    const [erp] = await prodPool.query(`SELECT pv.id AS vid, pv.sku, pv.product_type AS tipo, pv.sale_price,
        COALESCE((SELECT SUM(ls.quantity) FROM location_stocks ls WHERE ls.product_variation_id = pv.id), 0) AS stock,
        pv.woocommerce_id AS wc_id,
        COALESCE((SELECT vp.woocommerce_id FROM product_variations vp
                   WHERE vp.product_id = pv.product_id AND vp.product_type = 'variable' AND vp.deleted_at IS NULL
                   ORDER BY vp.id LIMIT 1), p.woocommerce_id) AS wc_padre
      FROM product_variations pv JOIN products p ON p.id = pv.product_id
      WHERE pv.id IN (?)`, [vids]);
    const E = new Map(erp.map(r => [Number(r.vid), r]));

    let escritos = 0;
    for (const vid of vids) {
      res.revisados++;
      const enCampana = campanaDe.has(vid), m = M.get(vid), e = E.get(vid);
      const cid = campanaDe.get(vid) ?? null;
      if (!e) { await guardar(vid, { seguir: 0, estado: 'error', nota: 'El SKU ya no existe en el sistema' }); continue; }
      const oferta = aNum(e.sale_price);
      const stock = Math.round(Number(e.stock) || 0);         // misma fórmula que el puente
      const stockMem = v => v == null ? null : Number(v);
      const sku = String(e.sku || '').trim();
      const ruta = e.tipo === 'simple' ? `/products/${e.wc_id}` : (e.wc_padre ? `/products/${e.wc_padre}/variations/${e.wc_id}` : null);

      // Ya está en la web con ese valor
      if (m && m.estado === 'ok' && igual(aNum(m.oferta_web), oferta) && stockMem(m.stock_web) === stock) {
        res.sin_cambio++;
        if (enCampana !== !!Number(m.seguir)) await guardar(vid, { seguir: enCampana ? 1 : 0 });
        continue;
      }
      // Sin ID o sin producto padre en la web: no hay dónde escribir
      if (!e.wc_id || !ruta) {
        await guardar(vid, { sku, seguir: enCampana ? 1 : 0, estado: 'sin_id', oferta_intento: oferta, stock_intento: stock,
          nota: !e.wc_id ? 'Sin WooCommerce ID en el sistema' : 'Variación sin producto padre en la web' });
        continue;
      }
      // Error reciente con este mismo valor: esperar antes de reintentar
      if (m && ['error', 'sku_distinto'].includes(m.estado) && igual(aNum(m.oferta_intento), oferta) && stockMem(m.stock_intento) === stock
          && m.intento_en && Date.now() - new Date(m.intento_en).getTime() < REINTENTO_MIN * 60e3) {
        if (!enCampana && m.estado === 'sku_distinto' && Number(m.seguir)) await guardar(vid, { seguir: 0 });  // ya salió de la campaña
        continue;
      }
      if (escritos >= MAX_POR_VUELTA) break;                 // el resto, en la siguiente vuelta

      const antes = m ? aNum(m.oferta_web) : undefined;
      try {
        // Leer en la web: confirmar SKU y ver qué oferta tiene hoy
        const w = await wc('GET', ruta);
        const skuWeb = String((w && w.sku) || '').trim();
        if (skuWeb && sku && skuWeb.toLowerCase() !== sku.toLowerCase()) {
          await guardar(vid, { sku, wc_id: e.wc_id, wc_padre: e.wc_padre, seguir: enCampana ? 1 : 0, estado: 'sku_distinto',
            oferta_intento: oferta, stock_intento: stock, nota: `En la web el ID ${e.wc_id} es "${skuWeb}"; no se tocó` });
          res.errores++; continue;
        }
        const enWeb = aNum(w && w.sale_price);
        const stockWeb = w && w.manage_stock && w.stock_quantity != null ? Number(w.stock_quantity) : null;
        const cambiaOferta = !igual(enWeb, oferta), cambiaStock = stockWeb !== stock;
        if (cambiaOferta || cambiaStock) {
          const cuerpo = {};
          if (cambiaOferta) cuerpo.sale_price = oferta == null ? '' : String(oferta);
          if (cambiaStock) Object.assign(cuerpo, { manage_stock: true, stock_quantity: stock, stock_status: stock > 0 ? 'instock' : 'outofstock' });
          const que = [cambiaOferta && `oferta ${txt(enWeb)} → ${txt(oferta)}`, cambiaStock && `stock ${stockWeb ?? '—'} → ${stock}`].filter(Boolean).join(', ');
          if (DRY) console.log(`[promo-web] (simulación) ${sku}: ${que}`);
          else {
            const r = await wc('PUT', ruta, cuerpo);
            if (cambiaOferta && !igual(aNum(r && r.sale_price), oferta)) throw new Error(`la web respondió oferta ${txt(aNum(r && r.sale_price))}`);
            if (cambiaStock && Number(r && r.stock_quantity) !== stock) throw new Error(`la web respondió stock ${r && r.stock_quantity}`);
            console.log(`[promo-web] ${sku}: ${que}`);
          }
          escritos++; res.subidos++;
          if (cambiaOferta) await logCampana(cid ?? await ultimaCampana(vid), vid, enWeb, oferta,   // el stock no va al historial (cambia con cada venta)
            (DRY ? '(simulación) ' : '') + (enCampana ? 'Precio oferta subido a la web' : 'Fin de campaña: oferta devuelta en la web'));
          await pausa(PAUSA_MS);
        } else res.sin_cambio++;
        if (DRY) continue;                                   // en simulación no se guarda memoria
        await guardar(vid, { sku, wc_id: e.wc_id, wc_padre: e.wc_padre, oferta_web: oferta, stock_web: stock, seguir: enCampana ? 1 : 0,
          estado: 'ok', oferta_intento: oferta, stock_intento: stock, nota: null, subido: true });
        await portalPool.query(`UPDATE sync_estado SET ultima_oferta = ?, ultimo_stock = ? WHERE variation_id = ?`, [oferta, stock, vid]).catch(() => {});
      } catch (err) {
        res.errores++;
        // Fuera de campaña, un error definitivo (404, 400…) ya no se reintenta; uno de conexión sí
        const definitivo = err.status >= 400 && err.status < 500 && err.status !== 429;
        await guardar(vid, { sku, wc_id: e.wc_id, wc_padre: e.wc_padre, seguir: enCampana || !definitivo ? 1 : 0, estado: 'error',
          oferta_intento: oferta, stock_intento: stock, nota: ('Error al subir: ' + err.message).slice(0, 300) });
        console.warn(`[promo-web] ${sku} (oferta ${txt(antes ?? null)} → ${txt(oferta)}, stock ${stock}): ${err.message}`);
      }
    }
    if (res.subidos || res.errores) console.log(`[promo-web] ${res.subidos} subido(s), ${res.errores} con error, ${res.sin_cambio} sin cambio.`);
    return res;
  }

  // Inserta o actualiza la memoria de un SKU (solo las columnas que se pasan)
  async function guardar(vid, d) {
    const cols = { seguir: d.seguir, estado: d.estado, nota: d.nota, sku: d.sku, wc_id: d.wc_id, wc_padre: d.wc_padre,
      oferta_intento: d.oferta_intento, stock_intento: d.stock_intento, stock_web: d.stock_web,
      ...('oferta_web' in d ? { oferta_web: d.oferta_web } : {}) };
    const k = Object.keys(cols).filter(c => cols[c] !== undefined);
    const fechas = [...(d.estado ? ['intento_en'] : []), ...(d.subido ? ['subido_en'] : [])];   // = NOW()
    await portalPool.query(
      `INSERT INTO promo_web (vid${k.map(c => ', ' + c).join('')}${fechas.map(c => ', ' + c).join('')})
       VALUES (?${k.map(() => ', ?').join('')}${fechas.map(() => ', NOW()').join('')})
       ON DUPLICATE KEY UPDATE ${[...k.map(c => `${c} = VALUES(${c})`), ...fechas.map(c => `${c} = NOW()`)].join(', ') || 'vid = vid'}`,
      [vid, ...k.map(c => cols[c])]);
  }
  async function ultimaCampana(vid) {
    const [[r]] = await portalPool.query(`SELECT campana_id FROM promo_items WHERE vid = ? ORDER BY id DESC LIMIT 1`, [vid]);
    return r ? r.campana_id : null;
  }
  const logCampana = (cid, vid, antes, despues, nota) => cid == null ? null : portalPool.query(
    `INSERT INTO promo_log (campana_id, vid, accion, antes, despues, nota) VALUES (?,?,?,?,?,?)`,
    [cid, vid, 'web', antes ?? null, despues, nota]).catch(() => {});

  // Estado para la pantalla / diagnóstico
  async function estado() {
    if (!listo) return { activo, simulacion: DRY };
    const [r] = await portalPool.query(`SELECT vid, sku, wc_id, oferta_web, stock_web, oferta_intento, stock_intento, seguir, estado, nota, intento_en, subido_en
      FROM promo_web WHERE seguir = 1 OR estado <> 'ok' ORDER BY (estado = 'ok'), sku LIMIT 500`);
    return { activo, simulacion: DRY, cada_min: CADA_MIN, ultima_vuelta: ultima, skus: r };
  }

  return { prepararTablas, avisar, revisar, estado, activo };
};
