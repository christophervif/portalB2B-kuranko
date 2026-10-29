// ═══════════════════════════════════════════════════════════════════════════
//  MÓDULO: Auditoría de catálogo → "Modificar en bloque" (pestaña Pendientes)
//  Escribe en el SISTEMA (ERP) con la cuenta de escritura del portal
//  (ERP_ESCRITURA_URL). La plantilla de WooCommerce y el puente leen de ahí.
//
//  POST /admin/auditoria/bloque/opciones      → factores del Cotizador y si se puede aplicar
//  POST /admin/auditoria/bloque/previsualizar  → qué cambiaría (antes → después), sin escribir
//  POST /admin/auditoria/bloque/aplicar        → escribe (una transacción) y deja log
//  GET  /admin/auditoria/bloque/log            → últimos cambios aplicados
//  Permiso: 'auditoria'.
//
//  Campos. Se aplica SIEMPRE el mismo valor a TODA la familia de cada fila elegida (fila
//  base/padre 'variable' + todas sus variaciones, o el simple): estado, reservas, peso y medidas.
//  El precio regular es el del grupo y también va en todas:
//    · estado         → product_variations.status ('active' | 'draft' | 'discontinued') en toda la
//                       familia: fila base/padre ('variable'), sus variaciones, o el simple
//    · reservas       → product_variation_stocks.backorder_mode ('no' | 'notify' | 'yes'),
//                       fila por fila (id), solo si sigue con el valor leído
//    · peso / medidas → product_variations.weight / length / width / height (DECIMAL 10,3 en la base,
//                       pero el modelo del ERP los lee y guarda con 2 decimales → se redondea a 2)
//    · precio regular → product_variations.regular_price DECIMAL(10,2) = precio del GRUPO: en el ERP
//                       se pone en el producto y vale para TODAS sus variaciones. PVP recomendado
//                       del Cotizador = costo de la ÚLTIMA compra (con IGV) ÷ COTIZADOR_FACTOR_PVP
//                       (0.65), hacia arriba; el mayor de sus variaciones; se escribe en todas sus
//                       filas (incluida la base is_default)
//  En el ERP (Laravel) estas columnas no tienen observers ni eventos: escribirlas por SQL
//  equivale a guardarlas desde el formulario. backorder_mode solo lo usa la web (el ERP no
//  bloquea ventas por él).
// ═══════════════════════════════════════════════════════════════════════════

const FACTOR_PVP = Number(process.env.COTIZADOR_FACTOR_PVP) || 0.65;  // igual que el Cotizador
const EXCLUIR_STOCK = (process.env.PROMO_EXCLUIR || process.env.STOCK_EXCLUIR || 'CUARENTENA,EMBAJADOR')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const ESTADOS = { active: 'Activa', draft: 'Borrador', discontinued: 'Descontinuada' };
const RESERVAS = { no: 'No permitir', notify: 'Permitir y avisar (A PEDIDO)', yes: 'Permitir' };
const nomReserva = m => m == null || m === '' ? 'vacío (= No permitir)' : (RESERVAS[m] || m);
const MEDIDAS = { weight: 'Peso (kg)', length: 'Largo (cm)', width: 'Ancho (cm)', height: 'Alto (cm)' };
const MAX_MEDIDA = 9999999;            // DECIMAL(10,3) admite hasta 9 999 999.999
const MAX_PRECIO = 99999999;           // DECIMAL(10,2) admite hasta 99 999 999.99

const num = x => (x === null || x === undefined || x === '') ? null : Number(x);
const igualNum = (a, b) => (num(a) === null && num(b) === null) || (num(a) !== null && num(b) !== null && Math.abs(num(a) - num(b)) < 0.0005);
const txt = x => x == null ? '' : String(x);

// ── Reglas del puente (copia de sync-stock-kuranko/campos.js) para la vista previa ──
function webDe(status, stock, back, nombre) {
  const inactivo = status === 'draft' || status === 'discontinued';
  const notify = back === 'notify' || back === 'yes';
  const publicado = inactivo ? 'Privado' : 'Publicado';
  let visible;
  if (inactivo) visible = false;
  else if (notify) visible = true;
  else if (/PCK/.test(txt(nombre))) visible = false;
  else visible = stock > 0;
  return `${publicado} · ${visible ? 'Visible' : 'Oculto'}${!inactivo && notify && !(stock > 0) ? ' · "A PEDIDO"' : ''}`;
}
function estadoPadre(hijos) {
  if (hijos.every(h => h === 'discontinued')) return 'discontinued';
  if (hijos.some(h => h === 'active')) return 'active';
  return 'draft';
}

// Valida y normaliza lo que llega del navegador (todo lo demás se ignora)
function leerCambios(c) {
  c = c || {};
  const out = {};
  if (c.precio_regular && ['vacios', 'subir', 'todos'].includes(c.precio_regular.alcance)) out.precio_regular = { alcance: c.precio_regular.alcance };
  if (c.reservas && Object.prototype.hasOwnProperty.call(RESERVAS, c.reservas)) out.reservas = c.reservas;
  if (c.estado && Object.prototype.hasOwnProperty.call(ESTADOS, c.estado)) out.estado = c.estado;
  for (const k of Object.keys(MEDIDAS)) {
    if (c[k] === '' || c[k] == null) continue;
    const v = Number(String(c[k]).replace(',', '.'));
    if (!isFinite(v) || v < 0 || v > MAX_MEDIDA) throw Object.assign(new Error(`${MEDIDAS[k]}: valor no válido (${c[k]}).`), { usuario: true });
    out[k] = Math.round(v * 100) / 100;   // el ERP muestra y guarda con 2 decimales (cast decimal:2 del modelo)
  }
  return out;
}

// ─── Cálculo puro: qué se escribe ───────────────────────────────────────────
//  d = { vars:[{id,product_id,sku,name,product_type,status,regular_price,weight,length,width,height,woocommerce_id,is_default}],
//        prods:[{id,name}], stock:{vid:n}, back:{vid:[{id,mode}]}, ultCosto:{vid:costo},
//        seleccion:Set(vid), objetivo:Set(vid) }
function planificar(d, cambios, hoy = Date.now()) {
  const avisos = [], escrituras = [];
  const prodPorId = {}; d.prods.forEach(p => prodPorId[p.id] = p);
  const w = (tabla, campo, ref, sku, antes, despues) => escrituras.push({ tabla, campo, ref, sku, antes, despues });

  // Toda la familia: la fila base/padre ('variable') y todas sus variaciones, o el simple
  const objetivo = d.vars.filter(v => d.objetivo.has(v.id));
  const filas = {};
  const fila = v => filas[v.id] = filas[v.id] || {
    vid: v.id, pid: v.product_id, sku: txt(v.sku).trim(), nombre: v.name || (prodPorId[v.product_id] || {}).name || '',
    tipo: v.product_type, en_web: !!v.woocommerce_id, seleccionada: d.seleccion.has(v.id), cambios: [] };
  const anota = (v, campo, antes, despues) => fila(v).cambios.push({ campo, antes, despues });
  objetivo.forEach(fila);
  const grupoPrecio = {}, nuevoEstado = {};

  // ── Precio regular = precio del GRUPO (producto) ──
  // En el ERP el precio regular se define en el producto padre y se aplica a TODAS sus
  // variaciones (EditProduct::cascadeRegularPriceToVariations; en la variación el campo
  // está bloqueado). Por eso se calcula un PVP por producto (el mayor PVP recomendado de
  // sus variaciones, para que ninguna quede bajo su costo) y se escribe en todas sus filas,
  // incluida la fila base/padre (is_default).
  const regularFinal = {};
  if (cambios.precio_regular) {
    const pidsObj = [...new Set(objetivo.map(v => v.product_id))];
    for (const pid of pidsObj) {
      const filasProd = d.vars.filter(v => v.product_id === pid);
      const hijas = filasProd.filter(v => v.product_type !== 'variable');
      const base = filasProd.find(v => Number(v.is_default) === 1) || hijas[0];
      const ref = txt(base && base.sku).trim() || ('producto #' + pid);
      // Precio actual del grupo: el mayor entre la fila base y sus variaciones (si la base está
      // vacía pero las variaciones tienen precio, se compara contra ese; así "solo si sube"
      // nunca baja y siempre se avisa si baja).
      const actual = Math.max(0, ...filasProd.map(f => num(f.regular_price) || 0)) || null;
      const pvps = hijas.map(h => d.ultCosto[h.id] > 0 ? Math.ceil(d.ultCosto[h.id] / FACTOR_PVP) : null).filter(x => x != null);
      if (!pvps.length) { avisos.push(`${ref}: ninguna variación tiene costo de compra registrado; no se calcula el PVP recomendado.`); continue; }
      const pvp = Math.max(...pvps);
      if (new Set(pvps).size > 1) avisos.push(`${ref}: sus variaciones tienen PVP recomendados distintos (${Math.min(...pvps)}–${pvp}); el precio del grupo usa el mayor (${pvp}).`);
      if (cambios.precio_regular.alcance === 'vacios' && actual > 0) continue;
      const baja = actual > 0 && pvp < actual;
      if (baja && cambios.precio_regular.alcance === 'subir') continue;
      if (pvp > MAX_PRECIO) { avisos.push(`${ref}: PVP calculado fuera de rango (${pvp}); no se cambia.`); continue; }
      if (baja) avisos.push(`${ref}: el PVP recomendado (${pvp}) BAJA el precio regular del grupo (${actual.toFixed(2)}).`);
      let cambiaAlgo = false;
      filasProd.forEach(f => {
        regularFinal[f.id] = pvp;
        if (!igualNum(f.regular_price, pvp)) cambiaAlgo = true;
        if (igualNum(f.regular_price, pvp)) return;
        w('product_variations', 'regular_price', f.id, txt(f.sku).trim() || ('#' + f.id), f.regular_price, pvp);
        if (d.objetivo.has(f.id)) {
          const r = num(f.regular_price);
          anota(f, 'Precio regular (grupo)', r > 0 ? r.toFixed(2) : '—', pvp.toFixed(2) + (baja ? ' (PVP recomendado — ⚠ baja)' : ' (PVP recomendado)'));
        }
      });
      if (cambiaAlgo) grupoPrecio[pid] = { antes: actual, despues: pvp, baja };
    }
  }

  const nuevaReserva = {};
  for (const v of objetivo) {
    const sku = txt(v.sku).trim() || ('#' + v.id);
    // Estado de la variación (Activa / Borrador / Descontinuada)
    if (cambios.estado && v.status !== cambios.estado) {
      w('product_variations', 'status', v.id, sku, v.status, cambios.estado);
      anota(v, 'Estado', ESTADOS[v.status] || v.status, ESTADOS[cambios.estado]);
      nuevoEstado[v.id] = cambios.estado;
    }
    // Reservas (cada fila de product_variation_stocks por su id)
    if (cambios.reservas) {
      const filasStock = d.back[v.id] || [];
      if (!filasStock.length) avisos.push(`${sku}: no tiene fila de stock en el sistema (product_variation_stocks); no se cambian sus reservas (el portal no crea esa fila).`);
      else {
        if (filasStock.length > 1) avisos.push(`${sku}: tiene ${filasStock.length} filas de stock en el sistema (debería tener 1); se cambian todas.`);
        filasStock.forEach(r => {
          if (r.mode === cambios.reservas) return;
          w('product_variation_stocks', 'backorder_mode', r.id, sku, r.mode, cambios.reservas);
          anota(v, 'Reservas', nomReserva(r.mode), RESERVAS[cambios.reservas]);
        });
        nuevaReserva[v.id] = cambios.reservas;
      }
    }
    // Peso y medidas
    for (const k of Object.keys(MEDIDAS)) {
      if (cambios[k] == null || igualNum(v[k], cambios[k])) continue;
      w('product_variations', k, v.id, sku, v[k], cambios[k]);
      anota(v, MEDIDAS[k], v[k] == null ? '—' : String(Number(v[k])), String(cambios[k]));
    }
    let regular = regularFinal[v.id] !== undefined ? regularFinal[v.id] : num(v.regular_price);

  }

  // Resumen por producto + cómo quedará en la web (solo cambian las reservas)
  const pids = [...new Set(objetivo.map(v => v.product_id))];
  const productos = pids.map(pid => {
    const p = prodPorId[pid] || { id: pid, name: '' };
    const hs = d.vars.filter(v => v.product_id === pid && v.product_type !== 'variable');
    const padre = d.vars.find(v => v.product_id === pid && v.product_type === 'variable');
    const stock = hs.reduce((s, h) => s + (d.stock[h.id] || 0), 0);
    const modo = h => ((d.back[h.id] || [])[0] || {}).mode;
    const backAct = hs.some(h => ['notify', 'yes'].includes(modo(h))) ? 'notify' : 'no';
    const backFin = hs.some(h => ['notify', 'yes'].includes(nuevaReserva[h.id] || modo(h))) ? 'notify' : 'no';
    const st = estadoPadre(hs.map(h => h.status));
    const stFin = estadoPadre(hs.map(h => nuevoEstado[h.id] || h.status));
    return {
      pid, nombre: p.name || '', sku: (padre && txt(padre.sku).trim()) || txt(hs[0] && hs[0].sku).trim(),
      tipo: padre || hs.length > 1 ? 'variable' : 'simple', variaciones: hs.length, en_web: hs.some(h => h.woocommerce_id),
      web_antes: webDe(st, stock, backAct, p.name), web_despues: webDe(stFin, stock, backFin, p.name),
      precio_grupo: grupoPrecio[pid] || null
    };
  });

  return {
    productos, filas: Object.values(filas).filter(f => f.cambios.length),
    escrituras, avisos: [...new Set(avisos)],
    resumen: { productos: pids.length, variaciones: objetivo.length, escrituras: escrituras.length }
  };
}

module.exports = function registrarBloque({ app, authAdmin, requiereModulo, prodPool, portalPool, erpWritePool }) {
  const mAud = requiereModulo('auditoria');

  // Lee del ERP lo necesario: los productos de las filas elegidas y TODAS sus variaciones
  async function leer(vids) {
    vids = [...new Set((vids || []).map(Number).filter(n => Number.isInteger(n) && n > 0))];
    if (!vids.length) throw Object.assign(new Error('No seleccionaste productos.'), { usuario: true });
    if (vids.length > 2000) throw Object.assign(new Error('Máximo 2000 productos por vez.'), { usuario: true });
    const [sel] = await prodPool.query(`SELECT DISTINCT product_id FROM product_variations WHERE id IN (?) AND deleted_at IS NULL`, [vids]);
    const pids = sel.map(r => r.product_id);
    if (!pids.length) throw new Error('No se encontraron los productos seleccionados.');
    const [vars] = await prodPool.query(
      `SELECT id, product_id, TRIM(sku) AS sku, name, product_type, status, regular_price,
              weight, length, width, height, woocommerce_id, is_default
         FROM product_variations WHERE deleted_at IS NULL AND product_id IN (?)`, [pids]);
    const [prods] = await prodPool.query(`SELECT id, name FROM products WHERE id IN (?)`, [pids]);
    const todas = vars.map(v => v.id);
    const q = (sql, a) => prodPool.query(sql, a).then(r => r[0]);
    const [st, back, uc] = await Promise.all([
      q(`SELECT ls.product_variation_id AS vid, SUM(ls.quantity) AS qty FROM location_stocks ls
           JOIN locations l ON l.id = ls.location_id
          WHERE ls.product_variation_id IN (?) AND UPPER(TRIM(l.name)) NOT IN (?) GROUP BY ls.product_variation_id`, [todas, EXCLUIR_STOCK.length ? EXCLUIR_STOCK : ['']]),
      q(`SELECT id, product_variation_id AS vid, backorder_mode FROM product_variation_stocks WHERE product_variation_id IN (?) ORDER BY id`, [todas]),
      q(`SELECT product_variation_id AS vid, cost_price FROM stock_batches WHERE cost_price > 0 AND product_variation_id IN (?)
          ORDER BY product_variation_id, entry_date DESC, id DESC`, [todas])
    ]);
    const d = {
      vars, prods, stock: {}, back: {}, ultCosto: {},
      seleccion: new Set(vids), objetivo: new Set(todas)   // siempre TODAS las variaciones (o el simple) del producto
    };
    st.forEach(r => d.stock[r.vid] = Number(r.qty) || 0);
    back.forEach(r => (d.back[r.vid] = d.back[r.vid] || []).push({ id: r.id, mode: r.backorder_mode }));
    uc.forEach(r => { if (!(r.vid in d.ultCosto)) d.ultCosto[r.vid] = Number(r.cost_price); });
    return d;
  }

  function validar(body) {
    const cambios = leerCambios(body.cambios);
    if (!Object.keys(cambios).length) throw Object.assign(new Error('Elige al menos un campo para cambiar.'), { usuario: true });
    return cambios;
  }

  app.post('/admin/auditoria/bloque/opciones', authAdmin, mAud, (req, res) => {
    res.json({ factor_pvp: FACTOR_PVP, puede_aplicar: !!erpWritePool });
  });

  app.post('/admin/auditoria/bloque/previsualizar', authAdmin, mAud, async (req, res) => {
    try {
      const cambios = validar(req.body || {});
      const plan = planificar(await leer(req.body.vids), cambios);
      delete plan.escrituras;
      res.json({ ...plan, puede_aplicar: !!erpWritePool });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // Escribe dentro de una transacción. Cada UPDATE solo afecta la fila si el valor sigue
  // siendo el que se leyó (<=>), así no se pisa algo que alguien cambió mientras tanto.
  // Si una sola escritura falla (p. ej. falta un permiso), se deshace todo.
  async function escribir(con, escrituras) {
    let aplicados = 0; const sinCambio = [];
    for (const e of escrituras) {
      let r;
      if (e.tabla === 'product_variation_stocks' && e.campo === 'backorder_mode') {
        [r] = await con.query(`UPDATE product_variation_stocks SET backorder_mode = ? WHERE id = ? AND backorder_mode <=> ?`, [e.despues, e.ref, e.antes]);
      } else if (e.tabla === 'product_variations' && ['weight', 'length', 'width', 'height', 'regular_price', 'status'].includes(e.campo)) {
        [r] = await con.query(`UPDATE product_variations SET ${e.campo} = ? WHERE id = ? AND deleted_at IS NULL AND ${e.campo} <=> ?`, [e.despues, e.ref, e.antes]);
      } else throw new Error(`Escritura no permitida: ${e.tabla}.${e.campo}`);
      if (r && r.affectedRows === 1) aplicados++;
      else if (r && r.affectedRows > 1) throw new Error(`${e.sku}: la escritura afectó ${r.affectedRows} filas (se esperaba 1).`);
      else sinCambio.push(e.sku);
    }
    return { aplicados, sinCambio };
  }

  app.post('/admin/auditoria/bloque/aplicar', authAdmin, mAud, async (req, res) => {
    if (!erpWritePool) return res.status(400).json({ error: 'Falta configurar ERP_ESCRITURA_URL (cuenta de escritura) en Railway.' });
    let con;
    try {
      const cambios = validar(req.body || {});
      const plan = planificar(await leer(req.body.vids), cambios);
      if (!plan.escrituras.length) return res.json({ ok: true, aplicados: 0, sin_cambio: 0, avisos: plan.avisos });
      con = await erpWritePool.getConnection();
      await con.beginTransaction();
      const { aplicados, sinCambio } = await escribir(con, plan.escrituras);
      await con.commit();
      try {
        await portalPool.query(`CREATE TABLE IF NOT EXISTS auditoria_bloque_log (
          id INT AUTO_INCREMENT PRIMARY KEY, tabla VARCHAR(40), campo VARCHAR(40), referencia BIGINT,
          sku VARCHAR(255), antes VARCHAR(500), despues VARCHAR(500), usuario VARCHAR(100),
          aplicado_en DATETIME DEFAULT CURRENT_TIMESTAMP, INDEX (aplicado_en))`);
        const u = (req.admin && req.admin.usuario) || '';
        await portalPool.query(`INSERT INTO auditoria_bloque_log (tabla, campo, referencia, sku, antes, despues, usuario) VALUES ?`,
          [plan.escrituras.map(e => [e.tabla, e.campo, e.ref, e.sku || '', txt(e.antes).slice(0, 500), txt(e.despues).slice(0, 500), u])]);
      } catch (e) { console.warn('[auditoria-bloque] no se pudo guardar el log:', e.message); }
      res.json({ ok: true, aplicados, sin_cambio: sinCambio.length, avisos: plan.avisos });
    } catch (e) {
      if (con) await con.rollback().catch(() => {});
      if (e.usuario) return res.status(400).json({ error: e.message });
      const permiso = /denied/i.test(e.message);
      res.status(permiso ? 403 : 500).json({ error: (permiso
        ? 'La cuenta de escritura no tiene permiso para este cambio (no se aplicó nada): '
        : 'No se aplicó nada (se deshizo todo): ') + e.message });
    } finally { if (con) con.release(); }
  });

  app.get('/admin/auditoria/bloque/log', authAdmin, mAud, async (req, res) => {
    try {
      const [rows] = await portalPool.query(`SELECT * FROM auditoria_bloque_log ORDER BY id DESC LIMIT 300`);
      res.json(rows);
    } catch (e) { res.json([]); }
  });
};

module.exports._test = { planificar, leerCambios, webDe, estadoPadre, FACTOR_PVP };
