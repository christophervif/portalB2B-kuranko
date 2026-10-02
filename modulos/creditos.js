// ═══════════════════════════════════════════════════════════════════════════
//  MÓDULO: Créditos (pestaña "Créditos", permiso 'saldo_favor')
//
//  1) Créditos a favor del CLIENTE: dinero que un cliente pagó en una venta
//     que luego se canceló y que no se le devolvió. Se registra venta por venta
//     desde las ventas canceladas con pago del ERP (solo lectura) y se va
//     consumiendo con "usos" (aplicaciones a compras nuevas).
//  2) Créditos a favor de la EMPRESA: saldos anotados a mano (p.ej. con un
//     proveedor) que se marcan "saldado" cuando se usan o cobran.
//
//  Todo lo que se escribe vive en la base del PORTAL. El ERP solo se lee.
//  Antes vivía dentro de clientes-bi.js; se separó para aislar el módulo.
// ═══════════════════════════════════════════════════════════════════════════

const { EMPRESAS_BI, nombreTrazable, cabeceraExcel } = require('./comunes');

// Fecha 'AAAA-MM-DD' en zona de Lima (no UTC: después de las 7 pm UTC ya es "mañana").
function diaLima(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date(d));
}
// Acepta solo 'AAAA-MM-DD'; si no, null
function fechaValida(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}
const r2 = n => Math.round(Number(n || 0) * 100) / 100;
const nombreEmpresa = id => id ? (EMPRESAS_BI[id] || ('Empresa ' + id)) : null;
const usuarioDe = req => (req.admin && req.admin.usuario) || 'admin';

module.exports = function registrarCreditos({ app, authAdmin, mSaldo, prodPool, portalPool }) {

  // ── Tablas (se crean/actualizan una sola vez por arranque) ────────────────
  let _tablas = null;
  function asegurarTablas() {
    if (!_tablas) _tablas = crearTablas().catch(e => { _tablas = null; throw e; });
    return _tablas;
  }
  async function agregarColumna(tabla, def) {
    try { await portalPool.query(`ALTER TABLE ${tabla} ADD COLUMN ${def}`); }
    catch (e) { /* ya existe */ }
  }
  async function crearTablas() {
    await portalPool.query(`
      CREATE TABLE IF NOT EXISTS creditos_cliente (
        id INT AUTO_INCREMENT PRIMARY KEY,
        customer_id BIGINT,
        cliente_nombre VARCHAR(255),
        cliente_doc VARCHAR(50),
        monto DECIMAL(12,2) NOT NULL,
        usado DECIMAL(12,2) NOT NULL DEFAULT 0,
        fecha DATE,
        origen VARCHAR(500),
        venta_ref VARCHAR(50),
        cuenta_ref VARCHAR(255),
        empresa_id BIGINT,
        empresa_vendedora BIGINT,
        estado VARCHAR(20) DEFAULT 'disponible',
        registrado_por VARCHAR(100),
        creado_en DATETIME DEFAULT CURRENT_TIMESTAMP,
        anulado TINYINT(1) DEFAULT 0,
        anulado_por VARCHAR(100),
        anulado_en DATETIME NULL
      )`);
    await agregarColumna('creditos_cliente', 'empresa_vendedora BIGINT');
    await agregarColumna('creditos_cliente', 'motivo_anulacion VARCHAR(500) NULL');

    // Historial de usos: cada vez que el crédito se aplica a una compra
    await portalPool.query(`
      CREATE TABLE IF NOT EXISTS creditos_cliente_usos (
        id INT AUTO_INCREMENT PRIMARY KEY,
        credito_id INT NOT NULL,
        monto DECIMAL(12,2) NOT NULL,
        fecha DATE,
        venta_aplicada VARCHAR(50),
        nota VARCHAR(500),
        registrado_por VARCHAR(100),
        creado_en DATETIME DEFAULT CURRENT_TIMESTAMP,
        revertido TINYINT(1) DEFAULT 0,
        revertido_por VARCHAR(100),
        revertido_en DATETIME NULL,
        INDEX (credito_id)
      )`);

    // Ventas canceladas revisadas que NO quedaron a favor (se devolvió el dinero)
    await portalPool.query(`
      CREATE TABLE IF NOT EXISTS creditos_revision (
        venta_ref VARCHAR(50) PRIMARY KEY,
        decision VARCHAR(20) NOT NULL DEFAULT 'devuelto',
        nota VARCHAR(500),
        registrado_por VARCHAR(100),
        creado_en DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);

    await portalPool.query(`
      CREATE TABLE IF NOT EXISTS creditos_empresa (
        id INT AUTO_INCREMENT PRIMARY KEY,
        empresa_id INT,
        contraparte VARCHAR(255),
        monto DECIMAL(12,2) NOT NULL,
        fecha DATE,
        nota VARCHAR(500),
        estado VARCHAR(20) DEFAULT 'disponible',
        saldado_por VARCHAR(100),
        saldado_en DATETIME NULL,
        registrado_por VARCHAR(100),
        creado_en DATETIME DEFAULT CURRENT_TIMESTAMP,
        anulado TINYINT(1) DEFAULT 0,
        anulado_por VARCHAR(100),
        anulado_en DATETIME NULL
      )`);
    await agregarColumna('creditos_empresa', 'motivo_anulacion VARCHAR(500) NULL');
  }

  function soloMaestroCred(req, res) {
    if (req.admin && req.admin.maestro) return true;
    res.status(403).json({ error: 'Solo el administrador maestro puede hacer esto.', codigo: 'solo_maestro' });
    return false;
  }

  // ── Ventas canceladas con pago (ERP) ─────────────────────────────────────
  // Si se pasa `code`, trae solo esa venta (para validar al registrar).
  async function ventasCanceladas({ q = '', code = null, limite = 500 } = {}) {
    const w = ["s.status = 'cancelled'", 's.deleted_at IS NULL'];
    const p = [];
    if (code) { w.push('s.code = ?'); p.push(code); }
    else if (q) {
      // El filtro va en SQL (antes se cortaba en 500 y luego se filtraba: las antiguas no salían)
      const like = '%' + q.replace(/[\\%_]/g, m => '\\' + m) + '%';
      w.push(`(s.code LIKE ? OR cli.document_number LIKE ? OR cli.business_name LIKE ?
               OR CONCAT(COALESCE(cli.first_name,''),' ',COALESCE(cli.last_name,'')) LIKE ?)`);
      p.push(like, like, like, like);
    }
    const [rows] = await prodPool.query(`
      SELECT s.id, s.code, s.total, s.created_at, s.customer_id,
        s.company_id AS empresa_vendedora,
        COALESCE(SUM(CASE WHEN sp.voided_at IS NULL THEN sp.amount ELSE 0 END),0) AS pagado_activo,
        COALESCE(SUM(CASE WHEN sp.voided_at IS NOT NULL THEN sp.amount ELSE 0 END),0) AS pagado_anulado,
        CASE WHEN cli.is_company=1 THEN cli.business_name
             ELSE TRIM(CONCAT(COALESCE(cli.first_name,''),' ',COALESCE(cli.last_name,''))) END AS cliente,
        cli.document_number AS cliente_doc,
        (SELECT ba.party_id FROM sale_payments sp2
           JOIN bank_accounts ba ON ba.id = sp2.bank_account_id
          WHERE sp2.sale_id = s.id AND ba.party_id IS NOT NULL
          ORDER BY sp2.amount DESC, sp2.id ASC
          LIMIT 1) AS empresa_id
      FROM sales s
      LEFT JOIN sale_payments sp ON sp.sale_id = s.id
      LEFT JOIN parties cli ON cli.id = s.customer_id
      WHERE ${w.join(' AND ')}
      GROUP BY s.id
      HAVING (pagado_activo + pagado_anulado) > 0
      ORDER BY s.created_at DESC
      LIMIT ${Math.min(Number(limite) || 500, 2000)}`, p);
    return rows.map(r => {
      const activo = Number(r.pagado_activo), anulado = Number(r.pagado_anulado);
      return {
        code: r.code, total: Number(r.total),
        // Al cancelar, el ERP anula el pago pero el dinero sí entró: el tope es activo + anulado.
        pagado: r2(activo + anulado),
        pagado_activo: activo, pagado_anulado: anulado,
        tiene_pago_activo: activo > 0, // lo normal es que esté anulado; si no, revisar
        fecha: diaLima(r.created_at),
        customer_id: r.customer_id,
        cliente: (r.cliente || '').trim() || '—', cliente_doc: r.cliente_doc || '—',
        empresa_id: r.empresa_id ? Number(r.empresa_id) : null,
        empresa_vendedora: r.empresa_vendedora ? Number(r.empresa_vendedora) : null
      };
    });
  }

  // GET ?q=texto&revision=pendientes|registradas|devueltas|todas&empresa=1|2
  app.get('/api/creditos-ventas-canceladas', authAdmin, mSaldo, async (req, res) => {
    try {
      await asegurarTablas();
      const q = String(req.query.q || '').trim();
      const revision = String(req.query.revision || 'pendientes');
      const empresa = Number(req.query.empresa) || null;
      let lista = await ventasCanceladas({ q });

      const [reg] = await portalPool.query(
        `SELECT venta_ref FROM creditos_cliente WHERE anulado = 0 AND venta_ref IS NOT NULL`);
      const [dev] = await portalPool.query(
        `SELECT venta_ref, nota, registrado_por, creado_en FROM creditos_revision`);
      const registradas = new Set(reg.map(r => r.venta_ref));
      const devueltas = {}; dev.forEach(d => { devueltas[d.venta_ref] = d; });

      lista = lista.map(v => {
        const d = devueltas[v.code];
        return {
          ...v,
          empresa_cuenta_nombre: nombreEmpresa(v.empresa_id),
          empresa_vendedora_nombre: nombreEmpresa(v.empresa_vendedora),
          ya_registrada: registradas.has(v.code),
          devuelta: !!d,
          devuelta_nota: d ? (d.nota || '') : '',
          devuelta_por: d ? d.registrado_por : null,
          revision: registradas.has(v.code) ? 'registrada' : (d ? 'devuelta' : 'pendiente')
        };
      });
      const conteo = {
        pendientes: lista.filter(v => v.revision === 'pendiente').length,
        registradas: lista.filter(v => v.revision === 'registrada').length,
        devueltas: lista.filter(v => v.revision === 'devuelta').length
      };
      if (empresa) lista = lista.filter(v => v.empresa_vendedora === empresa || v.empresa_id === empresa);
      const mapa = { pendientes: 'pendiente', registradas: 'registrada', devueltas: 'devuelta' };
      if (mapa[revision]) lista = lista.filter(v => v.revision === mapa[revision]);
      res.json({ total: lista.length, conteo, ventas: lista });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Marcar una venta cancelada como "dinero devuelto" (no genera crédito) / deshacer
  app.post('/api/creditos-ventas-canceladas/:code/devuelto', authAdmin, mSaldo, async (req, res) => {
    try {
      await asegurarTablas();
      const code = String(req.params.code || '').trim();
      const [v] = await ventasCanceladas({ code });
      if (!v) return res.status(404).json({ error: 'No se encontró esa venta cancelada con pago.' });
      const [reg] = await portalPool.query(
        `SELECT id FROM creditos_cliente WHERE venta_ref = ? AND anulado = 0`, [code]);
      if (reg.length) return res.status(400).json({ error: 'Esa venta ya tiene un crédito registrado. Anúlalo primero.' });
      const nota = String((req.body && req.body.nota) || '').trim().slice(0, 500) || null;
      await portalPool.query(
        `INSERT INTO creditos_revision (venta_ref, decision, nota, registrado_por) VALUES (?, 'devuelto', ?, ?)
         ON DUPLICATE KEY UPDATE nota = VALUES(nota), registrado_por = VALUES(registrado_por), creado_en = NOW()`,
        [code, nota, usuarioDe(req)]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.delete('/api/creditos-ventas-canceladas/:code/devuelto', authAdmin, mSaldo, async (req, res) => {
    try {
      await asegurarTablas();
      await portalPool.query(`DELETE FROM creditos_revision WHERE venta_ref = ?`, [String(req.params.code || '')]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Créditos a favor del cliente ─────────────────────────────────────────
  // Registrar: el cliente, la empresa y el tope se toman del ERP (no del navegador).
  app.post('/api/creditos', authAdmin, mSaldo, async (req, res) => {
    let conn;
    try {
      await asegurarTablas();
      const b = req.body || {};
      const code = String(b.venta_ref || '').trim();
      if (!code) return res.status(400).json({ error: 'Falta la venta de referencia.' });
      const monto = r2(b.monto);
      if (!(monto > 0)) return res.status(400).json({ error: 'El monto debe ser mayor a cero.' });

      const [v] = await ventasCanceladas({ code });
      if (!v) return res.status(400).json({ error: 'No se encontró esa venta cancelada con pago.' });
      if (monto > v.pagado + 0.01)
        return res.status(400).json({ error: `El monto (S/ ${monto.toFixed(2)}) no puede superar lo pagado en la venta (S/ ${v.pagado.toFixed(2)}).` });

      // Bloqueo por venta: evita que un doble clic registre dos créditos
      conn = await portalPool.getConnection();
      const [[lk]] = await conn.query(`SELECT GET_LOCK(?, 5) AS ok`, ['credito_venta_' + code]);
      if (!lk || lk.ok !== 1) return res.status(409).json({ error: 'Otro registro de esa venta está en curso. Intenta de nuevo.' });
      try {
        const [dup] = await conn.query(
          `SELECT id FROM creditos_cliente WHERE venta_ref = ? AND anulado = 0`, [code]);
        if (dup.length) return res.status(400).json({ error: 'Esa venta ya tiene un crédito registrado.' });

        let origen = `Pago de venta cancelada ${code}`;
        const nota = String(b.nota || '').trim();
        if (nota) origen += ` — ${nota}`;
        await conn.query(
          `INSERT INTO creditos_cliente
            (customer_id, cliente_nombre, cliente_doc, monto, fecha, origen, venta_ref, cuenta_ref,
             empresa_id, empresa_vendedora, registrado_por)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          [v.customer_id || null, v.cliente, v.cliente_doc, monto,
           fechaValida(b.fecha) || v.fecha || diaLima(), origen.slice(0, 500), code,
           nombreEmpresa(v.empresa_id), v.empresa_id, v.empresa_vendedora, usuarioDe(req)]);
        // Si estaba marcada como devuelta, ya no lo está
        await conn.query(`DELETE FROM creditos_revision WHERE venta_ref = ?`, [code]);
      } finally {
        await conn.query(`SELECT RELEASE_LOCK(?)`, ['credito_venta_' + code]).catch(() => {});
      }
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
    finally { if (conn) conn.release(); }
  });

  async function listarCreditosCliente() {
    await asegurarTablas();
    const [rows] = await portalPool.query(`
      SELECT c.*, DATE_FORMAT(c.fecha, '%Y-%m-%d') AS fecha_txt
      FROM creditos_cliente c ORDER BY c.anulado ASC, c.creado_en DESC`);
    const [usos] = await portalPool.query(`
      SELECT u.*, DATE_FORMAT(u.fecha, '%Y-%m-%d') AS fecha_txt
      FROM creditos_cliente_usos u ORDER BY u.creado_en ASC`);
    const usosPor = {};
    usos.forEach(u => (usosPor[u.credito_id] = usosPor[u.credito_id] || []).push({
      id: u.id, monto: Number(u.monto), fecha: u.fecha_txt, venta_aplicada: u.venta_aplicada || '',
      nota: u.nota || '', registrado_por: u.registrado_por, creado_en: u.creado_en,
      revertido: u.revertido === 1, revertido_por: u.revertido_por || null, revertido_en: u.revertido_en || null
    }));

    // Créditos antiguos sin empresa vendedora guardada: buscarla en el ERP
    const faltan = [...new Set(rows.filter(c => !c.empresa_vendedora && c.venta_ref).map(c => c.venta_ref))];
    const vendPorVenta = {};
    if (faltan.length) {
      try {
        const [vs] = await prodPool.query(`SELECT code, company_id FROM sales WHERE code IN (?)`, [faltan]);
        vs.forEach(v => { vendPorVenta[v.code] = v.company_id; });
      } catch (e) { /* quedan en '—' */ }
    }

    return rows.map(c => {
      const anulado = c.anulado === 1;
      const usado = Number(c.usado);
      const saldo = r2(Number(c.monto) - usado);
      const vendId = c.empresa_vendedora || vendPorVenta[c.venta_ref] || null;
      return {
        id: c.id, customer_id: c.customer_id,
        cliente: c.cliente_nombre || '—', cliente_doc: c.cliente_doc || '—',
        monto: Number(c.monto), usado, saldo,
        fecha: c.fecha_txt, origen: c.origen, venta_ref: c.venta_ref,
        empresa_cuenta_id: c.empresa_id ? Number(c.empresa_id) : null,
        empresa_cuenta: c.empresa_id ? (EMPRESAS_BI[c.empresa_id] || c.cuenta_ref) : (c.cuenta_ref || '—'),
        empresa_vendedora_id: vendId ? Number(vendId) : null,
        empresa_vendedora: nombreEmpresa(vendId) || '—',
        estado: anulado ? 'anulado' : (saldo <= 0 ? 'agotado' : (usado > 0 ? 'parcial' : 'disponible')),
        anulado, anulado_por: c.anulado_por || null, anulado_en: c.anulado_en || null,
        motivo_anulacion: c.motivo_anulacion || '',
        registrado_por: c.registrado_por, creado_en: c.creado_en,
        usos: usosPor[c.id] || []
      };
    });
  }

  app.get('/api/creditos', authAdmin, mSaldo, async (req, res) => {
    try {
      const lista = await listarCreditosCliente();
      const vivos = lista.filter(x => !x.anulado);
      res.json({
        total: lista.length, activos: vivos.length,
        total_disponible: r2(vivos.reduce((s, x) => s + x.saldo, 0)),
        creditos: lista
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Aplicar (usar) parte o todo el saldo de un crédito en una compra
  app.post('/api/creditos/:id/usar', authAdmin, mSaldo, async (req, res) => {
    let conn;
    try {
      await asegurarTablas();
      const b = req.body || {};
      const monto = r2(b.monto);
      if (!(monto > 0)) return res.status(400).json({ error: 'El monto debe ser mayor a cero.' });
      const ventaAplicada = String(b.venta_aplicada || '').trim().slice(0, 50) || null;
      const nota = String(b.nota || '').trim().slice(0, 500) || null;
      if (!ventaAplicada && !nota)
        return res.status(400).json({ error: 'Indica la venta donde se aplicó o una nota.' });
      if (ventaAplicada) {
        const [vs] = await prodPool.query(
          `SELECT id FROM sales WHERE code = ? AND deleted_at IS NULL LIMIT 1`, [ventaAplicada]);
        if (!vs.length) return res.status(400).json({ error: `No existe la venta ${ventaAplicada} en el sistema.` });
      }
      conn = await portalPool.getConnection();
      await conn.beginTransaction();
      const [[c]] = await conn.query(
        `SELECT id, monto, usado, anulado FROM creditos_cliente WHERE id = ? FOR UPDATE`, [req.params.id]);
      if (!c) { await conn.rollback(); return res.status(404).json({ error: 'Crédito no encontrado.' }); }
      if (c.anulado === 1) { await conn.rollback(); return res.status(400).json({ error: 'El crédito está anulado.' }); }
      const saldo = r2(Number(c.monto) - Number(c.usado));
      if (monto > saldo + 0.001) {
        await conn.rollback();
        return res.status(400).json({ error: `El monto supera el saldo disponible (S/ ${saldo.toFixed(2)}).` });
      }
      await conn.query(
        `INSERT INTO creditos_cliente_usos (credito_id, monto, fecha, venta_aplicada, nota, registrado_por)
         VALUES (?,?,?,?,?,?)`,
        [c.id, monto, fechaValida(b.fecha) || diaLima(), ventaAplicada, nota, usuarioDe(req)]);
      await conn.query(`UPDATE creditos_cliente SET usado = usado + ? WHERE id = ?`, [monto, c.id]);
      await conn.commit();
      res.json({ ok: true, saldo: r2(saldo - monto) });
    } catch (e) {
      if (conn) await conn.rollback().catch(() => {});
      res.status(500).json({ error: e.message });
    } finally { if (conn) conn.release(); }
  });

  // Revertir un uso (solo maestro): devuelve ese monto al saldo
  app.post('/api/creditos/usos/:usoId/revertir', authAdmin, mSaldo, async (req, res) => {
    if (!soloMaestroCred(req, res)) return;
    let conn;
    try {
      await asegurarTablas();
      conn = await portalPool.getConnection();
      await conn.beginTransaction();
      const [[u]] = await conn.query(
        `SELECT id, credito_id, monto, revertido FROM creditos_cliente_usos WHERE id = ? FOR UPDATE`, [req.params.usoId]);
      if (!u) { await conn.rollback(); return res.status(404).json({ error: 'Uso no encontrado.' }); }
      if (u.revertido === 1) { await conn.rollback(); return res.status(400).json({ error: 'Ese uso ya fue revertido.' }); }
      await conn.query(
        `UPDATE creditos_cliente_usos SET revertido = 1, revertido_por = ?, revertido_en = NOW() WHERE id = ?`,
        [usuarioDe(req), u.id]);
      await conn.query(
        `UPDATE creditos_cliente SET usado = GREATEST(usado - ?, 0) WHERE id = ?`, [Number(u.monto), u.credito_id]);
      await conn.commit();
      res.json({ ok: true });
    } catch (e) {
      if (conn) await conn.rollback().catch(() => {});
      res.status(500).json({ error: e.message });
    } finally { if (conn) conn.release(); }
  });

  app.post('/api/creditos/:id/anular', authAdmin, mSaldo, async (req, res) => {
    if (!soloMaestroCred(req, res)) return;
    try {
      await asegurarTablas();
      const motivo = String((req.body && req.body.motivo) || '').trim().slice(0, 500) || null;
      const [r] = await portalPool.query(
        `UPDATE creditos_cliente SET anulado = 1, anulado_por = ?, anulado_en = NOW(), motivo_anulacion = ?
         WHERE id = ? AND anulado = 0`, [usuarioDe(req), motivo, req.params.id]);
      if (!r.affectedRows) return res.status(404).json({ error: 'Crédito no encontrado o ya anulado.' });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Créditos a favor de la empresa ───────────────────────────────────────
  async function listarCreditosEmpresa() {
    await asegurarTablas();
    const [rows] = await portalPool.query(`
      SELECT c.*, DATE_FORMAT(c.fecha, '%Y-%m-%d') AS fecha_txt
      FROM creditos_empresa c ORDER BY c.anulado ASC, c.estado ASC, c.creado_en DESC`);
    return rows.map(c => {
      const anulado = c.anulado === 1, saldado = c.estado === 'saldado';
      return {
        id: c.id, empresa_id: c.empresa_id,
        empresa: nombreEmpresa(c.empresa_id) || '—',
        contraparte: c.contraparte || '—', monto: Number(c.monto),
        fecha: c.fecha_txt, nota: c.nota || '',
        estado: anulado ? 'anulado' : (saldado ? 'saldado' : 'disponible'),
        anulado, saldado,
        saldado_por: c.saldado_por || null, saldado_en: c.saldado_en || null,
        anulado_por: c.anulado_por || null, anulado_en: c.anulado_en || null,
        motivo_anulacion: c.motivo_anulacion || '',
        registrado_por: c.registrado_por, creado_en: c.creado_en
      };
    });
  }

  app.get('/api/creditos-empresa', authAdmin, mSaldo, async (req, res) => {
    try {
      const lista = await listarCreditosEmpresa();
      const disp = lista.filter(x => x.estado === 'disponible');
      res.json({
        total: lista.length, disponibles: disp.length,
        total_disponible: r2(disp.reduce((s, x) => s + x.monto, 0)), creditos: lista
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/creditos-empresa', authAdmin, mSaldo, async (req, res) => {
    try {
      await asegurarTablas();
      const b = req.body || {};
      const empresa_id = Number(b.empresa_id);
      if (!EMPRESAS_BI[empresa_id]) return res.status(400).json({ error: 'Elige la empresa beneficiaria.' });
      const monto = r2(b.monto);
      if (!(monto > 0)) return res.status(400).json({ error: 'El monto debe ser mayor a cero.' });
      const contraparte = String(b.contraparte || '').trim().slice(0, 255);
      if (!contraparte) return res.status(400).json({ error: 'Indica la contraparte (de quién es el crédito).' });
      await portalPool.query(
        `INSERT INTO creditos_empresa (empresa_id, contraparte, monto, fecha, nota, registrado_por)
         VALUES (?,?,?,?,?,?)`,
        [empresa_id, contraparte, monto, fechaValida(b.fecha) || diaLima(),
         String(b.nota || '').trim().slice(0, 500) || null, usuarioDe(req)]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Saldar / reabrir
  app.post('/api/creditos-empresa/:id/saldar', authAdmin, mSaldo, async (req, res) => {
    try {
      await asegurarTablas();
      const saldar = !(req.body && req.body.saldar === false);
      const [r] = saldar
        ? await portalPool.query(
            `UPDATE creditos_empresa SET estado='saldado', saldado_por=?, saldado_en=NOW()
             WHERE id=? AND anulado=0 AND estado='disponible'`, [usuarioDe(req), req.params.id])
        : await portalPool.query(
            `UPDATE creditos_empresa SET estado='disponible', saldado_por=NULL, saldado_en=NULL
             WHERE id=? AND anulado=0 AND estado='saldado'`, [req.params.id]);
      if (!r.affectedRows) return res.status(400).json({ error: 'El crédito no existe o ya cambió de estado. Actualiza la lista.' });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/creditos-empresa/:id/anular', authAdmin, mSaldo, async (req, res) => {
    if (!soloMaestroCred(req, res)) return;
    try {
      await asegurarTablas();
      const motivo = String((req.body && req.body.motivo) || '').trim().slice(0, 500) || null;
      const [r] = await portalPool.query(
        `UPDATE creditos_empresa SET anulado=1, anulado_por=?, anulado_en=NOW(), motivo_anulacion=?
         WHERE id=? AND anulado=0`, [usuarioDe(req), motivo, req.params.id]);
      if (!r.affectedRows) return res.status(404).json({ error: 'Crédito no encontrado o ya anulado.' });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Excel: créditos de clientes (con usos) y de la empresa ───────────────
  app.get('/api/creditos-excel', authAdmin, mSaldo, async (req, res) => {
    try {
      const ExcelJS = require('exceljs');
      const cli = await listarCreditosCliente();
      const emp = await listarCreditosEmpresa();
      const wb = new ExcelJS.Workbook();
      const cabecera = (ws, cols) => {
        cols.forEach((c, i) => { ws.getColumn(i + 1).width = c[1]; });
        const hr = ws.addRow(cols.map(c => c[0]));
        hr.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        hr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF000726' } };
        return hr.number;
      };

      const ws1 = wb.addWorksheet('A favor de clientes');
      cabeceraExcel(ws1, 'Créditos a favor de clientes', [['Registros', cli.length]], 13);
      const h1 = cabecera(ws1, [['Cliente', 32], ['RUC/DNI', 14], ['Fecha', 11], ['Venta origen', 14],
        ['Nota / origen', 40], ['Empresa vendedora', 24], ['Dinero en cuenta de', 24], ['Monto', 12],
        ['Usado', 12], ['Saldo', 12], ['Estado', 11], ['Registró', 14], ['Anulación', 30]]);
      cli.forEach(c => ws1.addRow([c.cliente, c.cliente_doc, c.fecha || '', c.venta_ref || '', c.origen || '',
        c.empresa_vendedora, c.empresa_cuenta, c.monto, c.usado, c.anulado ? 0 : c.saldo, c.estado,
        c.registrado_por || '', c.anulado ? `${c.anulado_por || ''} ${c.motivo_anulacion || ''}`.trim() : '']));
      [8, 9, 10].forEach(n => { ws1.getColumn(n).numFmt = '#,##0.00'; });
      ws1.views = [{ state: 'frozen', ySplit: h1 }];
      ws1.autoFilter = { from: { row: h1, column: 1 }, to: { row: h1, column: 13 } };

      const ws2 = wb.addWorksheet('Usos de créditos');
      cabeceraExcel(ws2, 'Usos de créditos de clientes', [], 8);
      const h2 = cabecera(ws2, [['Cliente', 32], ['Venta origen', 14], ['Fecha uso', 11], ['Aplicado en venta', 16],
        ['Monto', 12], ['Nota', 40], ['Registró', 14], ['Revertido', 12]]);
      cli.forEach(c => c.usos.forEach(u => ws2.addRow([c.cliente, c.venta_ref || '', u.fecha || '',
        u.venta_aplicada, u.monto, u.nota, u.registrado_por || '', u.revertido ? 'Sí' : ''])));
      ws2.getColumn(5).numFmt = '#,##0.00';
      ws2.views = [{ state: 'frozen', ySplit: h2 }];

      const ws3 = wb.addWorksheet('A favor de la empresa');
      cabeceraExcel(ws3, 'Créditos a favor de la empresa', [['Registros', emp.length]], 8);
      const h3 = cabecera(ws3, [['Empresa', 26], ['Contraparte', 28], ['Fecha', 11], ['Concepto / nota', 40],
        ['Monto', 12], ['Estado', 11], ['Registró', 14], ['Saldado / anulado por', 22]]);
      emp.forEach(c => ws3.addRow([c.empresa, c.contraparte, c.fecha || '', c.nota, c.monto, c.estado,
        c.registrado_por || '', c.anulado ? (c.anulado_por || '') : (c.saldado_por || '')]));
      ws3.getColumn(5).numFmt = '#,##0.00';
      ws3.views = [{ state: 'frozen', ySplit: h3 }];

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${nombreTrazable('creditos')}.xlsx"`);
      await wb.xlsx.write(res);
      res.end();
    } catch (e) { res.status(500).json({ error: 'Error al generar el Excel: ' + e.message }); }
  });

  return { _test: { diaLima, fechaValida } };
};
