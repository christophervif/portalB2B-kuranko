// ═══════════════════════════════════════════════════════════════════════════
//  MÓDULO: Créditos (saldo a favor)  — permiso: saldo_favor
//  · Créditos a favor del CLIENTE (nacen de ventas canceladas con pago).
//  · Créditos a favor de la EMPRESA (anotados a mano).
//  Ambos viven en la base del PORTAL. Frontend: public/saldo-a-favor.html.
//  (Antes vivía dentro de modulos/clientes-bi.js; se separó sin cambiar lógica.)
// ═══════════════════════════════════════════════════════════════════════════

module.exports = function registrarCreditos({ app, authAdmin, mSaldo, prodPool, portalPool }) {

  async function asegurarTablaCreditos() {
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
    // Por si la tabla ya existía sin la columna de empresa vendedora
    try {
      await portalPool.query(`ALTER TABLE creditos_cliente ADD COLUMN empresa_vendedora BIGINT`);
    } catch (e) { /* la columna ya existe */ }
  }


  app.get('/api/creditos-ventas-canceladas', authAdmin, mSaldo, async (req, res) => {
    try {
      const q = (req.query.q || '').trim();
      const [rows] = await prodPool.query(`
        SELECT s.id, s.code, s.total, s.created_at, s.customer_id,
          s.company_id AS empresa_vendedora,
          COALESCE(SUM(CASE WHEN sp.voided_at IS NULL THEN sp.amount ELSE 0 END),0) AS pagado_activo,
          COALESCE(SUM(CASE WHEN sp.voided_at IS NOT NULL THEN sp.amount ELSE 0 END),0) AS pagado_anulado,
          CASE WHEN cli.is_company=1 THEN cli.business_name
               ELSE TRIM(CONCAT(COALESCE(cli.first_name,''),' ',COALESCE(cli.last_name,''))) END AS cliente,
          cli.document_number AS cliente_doc,
          (SELECT ba.party_id FROM sale_payments sp2
           LEFT JOIN bank_accounts ba ON ba.id = sp2.bank_account_id
           WHERE sp2.sale_id = s.id AND ba.party_id IS NOT NULL
           LIMIT 1) AS empresa_id
        FROM sales s
        LEFT JOIN sale_payments sp ON sp.sale_id = s.id
        LEFT JOIN parties cli ON cli.id = s.customer_id
        WHERE s.status = 'cancelled' AND s.deleted_at IS NULL
        GROUP BY s.id
        HAVING (pagado_activo + pagado_anulado) > 0
        ORDER BY s.created_at DESC
        LIMIT 500`);
      // Marcar cuáles ya tienen crédito registrado (para no duplicar)
      await asegurarTablaCreditos();
      const [yaReg] = await portalPool.query(
        `SELECT venta_ref FROM creditos_cliente WHERE anulado = 0 AND venta_ref IS NOT NULL`);
      const registradas = new Set(yaReg.map(r => r.venta_ref));
      let lista = rows.map(r => {
        const activo = Number(r.pagado_activo), anulado = Number(r.pagado_anulado);
        // El "dinero que entró" es el total pagado (activo + anulado); ese es el tope del crédito
        const pagado = Math.round((activo + anulado) * 100) / 100;
        return {
          code: r.code, total: Number(r.total), pagado,
          pagado_activo: activo, pagado_anulado: anulado,
          // Etiqueta: normal = pago anulado (esperado al cancelar); "activo" = anomalía
          tiene_pago_activo: activo > 0,
          fecha: r.created_at, customer_id: r.customer_id,
          cliente: (r.cliente || '').trim() || '—', cliente_doc: r.cliente_doc || '—',
          empresa_id: r.empresa_id,
          empresa_vendedora: r.empresa_vendedora,
          ya_registrada: registradas.has(r.code)
        };
      });
      if (q) {
        const ql = q.toLowerCase();
        lista = lista.filter(x =>
          x.code.toLowerCase().includes(ql) ||
          x.cliente.toLowerCase().includes(ql) ||
          (x.cliente_doc || '').includes(q));
      }
      res.json({ total: lista.length, ventas: lista });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });


  app.post('/api/creditos', authAdmin, mSaldo, async (req, res) => {
    try {
      await asegurarTablaCreditos();
      const b = req.body || {};
      if (!b.venta_ref) return res.status(400).json({ error: 'Falta la venta de referencia.' });
      const monto = Number(b.monto);
      if (!(monto > 0)) return res.status(400).json({ error: 'El monto debe ser mayor a cero.' });
      // Verificar contra el ERP que el monto no exceda lo realmente pagado en esa venta
      // (cuenta pagos activos Y anulados: al cancelar se anula el pago, pero el dinero entró)
      const [[vRef]] = await prodPool.query(`
        SELECT COALESCE(SUM(sp.amount),0) AS pagado
        FROM sales s
        LEFT JOIN sale_payments sp ON sp.sale_id = s.id
        WHERE s.code = ? AND s.status = 'cancelled' AND s.deleted_at IS NULL
        GROUP BY s.id`, [b.venta_ref]);
      if (!vRef) return res.status(400).json({ error: 'No se encontró esa venta cancelada con pago.' });
      const pagadoReal = Number(vRef.pagado);
      // Tolerancia de 1 céntimo por redondeo
      if (monto > pagadoReal + 0.01) {
        return res.status(400).json({
          error: `El monto (S/ ${monto.toFixed(2)}) no puede superar lo pagado en la venta (S/ ${pagadoReal.toFixed(2)}).`
        });
      }
      // Evitar duplicar el crédito de una misma venta
      const [dup] = await portalPool.query(
        `SELECT id FROM creditos_cliente WHERE venta_ref = ? AND anulado = 0`, [b.venta_ref]);
      if (dup.length) return res.status(400).json({ error: 'Esa venta ya tiene un crédito registrado.' });
      const CONC = { 1: 'Diseños Corporativos SAC', 2: 'Christopher Villasante F.' };
      // El origen combina el motivo base con la nota del usuario (en qué se usó el resto)
      let origen = b.origen || `Pago de venta cancelada ${b.venta_ref}`;
      if (b.nota && b.nota.trim()) origen += ` — ${b.nota.trim()}`;
      await portalPool.query(
        `INSERT INTO creditos_cliente
          (customer_id, cliente_nombre, cliente_doc, monto, fecha, origen, venta_ref, cuenta_ref, empresa_id, empresa_vendedora, registrado_por)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [b.customer_id || null, b.cliente_nombre || null, b.cliente_doc || null,
         monto, b.fecha || new Date().toISOString().slice(0, 10),
         origen, b.venta_ref, (b.empresa_id ? CONC[b.empresa_id] : null) || b.cuenta_ref || null,
         b.empresa_id || null, b.empresa_vendedora || null, (req.admin && req.admin.usuario) || 'admin']);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });


  app.get('/api/creditos', authAdmin, mSaldo, async (req, res) => {
    try {
      await asegurarTablaCreditos();
      const [rows] = await portalPool.query(
        `SELECT * FROM creditos_cliente ORDER BY anulado ASC, creado_en DESC`);
      const CONC = { 1: 'Diseños Corporativos SAC', 2: 'Christopher Villasante F.' };

      // Para créditos viejos sin empresa vendedora guardada, buscarla en el ERP por su venta
      const sinVendedora = rows.filter(c => !c.empresa_vendedora && c.venta_ref && c.anulado !== 1);
      const vendedoraPorVenta = {};
      if (sinVendedora.length) {
        const codes = [...new Set(sinVendedora.map(c => c.venta_ref))];
        try {
          const [ventas] = await prodPool.query(
            `SELECT code, company_id FROM sales WHERE code IN (?)`, [codes]);
          ventas.forEach(v => { vendedoraPorVenta[v.code] = v.company_id; });
        } catch (e) { /* si falla, quedan en '—' */ }
      }

      const lista = rows.map(c => {
        const saldo = Math.round((Number(c.monto) - Number(c.usado)) * 100) / 100;
        // Empresa vendedora: la guardada, o la recuperada del ERP para registros viejos
        const vendId = c.empresa_vendedora || vendedoraPorVenta[c.venta_ref] || null;
        const anulado = c.anulado === 1;
        return {
          id: c.id, cliente: c.cliente_nombre || '—', cliente_doc: c.cliente_doc || '—',
          monto: Number(c.monto), usado: Number(c.usado), saldo,
          fecha: c.fecha, origen: c.origen, venta_ref: c.venta_ref,
          empresa_cuenta: c.empresa_id ? (CONC[c.empresa_id] || c.cuenta_ref) : (c.cuenta_ref || '—'),
          empresa_vendedora: vendId ? (CONC[vendId] || ('Empresa ' + vendId)) : '—',
          estado: anulado ? 'anulado'
            : (saldo <= 0 ? 'agotado' : (Number(c.usado) > 0 ? 'parcial' : 'disponible')),
          anulado,
          anulado_por: c.anulado_por || null,
          anulado_en: c.anulado_en || null,
          registrado_por: c.registrado_por, creado_en: c.creado_en
        };
      });
      // El total disponible NO cuenta los anulados
      const totalDisponible = lista.filter(x => !x.anulado).reduce((s, x) => s + x.saldo, 0);
      const activos = lista.filter(x => !x.anulado).length;
      res.json({ total: lista.length, activos, total_disponible: totalDisponible, creditos: lista });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });


  app.post('/api/creditos/:id/anular', authAdmin, mSaldo, async (req, res) => {
    try {
      if (!req.admin || !req.admin.maestro)
        return res.status(403).json({ error: 'Solo el administrador maestro puede anular créditos.' });
      await portalPool.query(
        `UPDATE creditos_cliente SET anulado = 1, anulado_por = ?, anulado_en = NOW() WHERE id = ?`,
        [req.admin.usuario, req.params.id]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });


  // ═══════════════════════════════════════════════════════════════════════
  //  CRÉDITOS A FAVOR DE LA EMPRESA (anotados a mano)
  //  Dinero que queda a favor de la empresa (p.ej. con un proveedor). Se anota
  //  manualmente y se marca "saldado" de un golpe. Vive en la base del PORTAL.
  // ═══════════════════════════════════════════════════════════════════════
  const CONC_EMP = { 1: 'Diseños Corporativos SAC', 2: 'Christopher Villasante F.' };

  async function asegurarTablaCreditosEmpresa() {
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
  }

  // Listar créditos a favor de la empresa
  app.get('/api/creditos-empresa', authAdmin, mSaldo, async (req, res) => {
    try {
      await asegurarTablaCreditosEmpresa();
      const [rows] = await portalPool.query(
        `SELECT * FROM creditos_empresa ORDER BY anulado ASC, estado ASC, creado_en DESC`);
      const lista = rows.map(c => {
        const anulado = c.anulado === 1;
        const saldado = c.estado === 'saldado';
        return {
          id: c.id,
          empresa_id: c.empresa_id,
          empresa: CONC_EMP[c.empresa_id] || (c.empresa_id ? ('Empresa ' + c.empresa_id) : '—'),
          contraparte: c.contraparte || '—',
          monto: Number(c.monto),
          fecha: c.fecha,
          nota: c.nota || '',
          estado: anulado ? 'anulado' : (saldado ? 'saldado' : 'disponible'),
          anulado, saldado,
          saldado_por: c.saldado_por || null, saldado_en: c.saldado_en || null,
          anulado_por: c.anulado_por || null, anulado_en: c.anulado_en || null,
          registrado_por: c.registrado_por, creado_en: c.creado_en
        };
      });
      // El total disponible NO cuenta ni saldados ni anulados
      const totalDisponible = lista
        .filter(x => x.estado === 'disponible')
        .reduce((s, x) => s + x.monto, 0);
      const disponibles = lista.filter(x => x.estado === 'disponible').length;
      res.json({ total: lista.length, disponibles, total_disponible: totalDisponible, creditos: lista });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Registrar un crédito a favor de la empresa
  app.post('/api/creditos-empresa', authAdmin, mSaldo, async (req, res) => {
    try {
      await asegurarTablaCreditosEmpresa();
      const b = req.body || {};
      const empresa_id = Number(b.empresa_id);
      if (!CONC_EMP[empresa_id]) return res.status(400).json({ error: 'Elige la empresa beneficiaria.' });
      const monto = Number(b.monto);
      if (!(monto > 0)) return res.status(400).json({ error: 'El monto debe ser mayor a cero.' });
      const contraparte = (b.contraparte || '').trim();
      if (!contraparte) return res.status(400).json({ error: 'Indica la contraparte (de quién es el crédito).' });
      await portalPool.query(
        `INSERT INTO creditos_empresa (empresa_id, contraparte, monto, fecha, nota, registrado_por)
         VALUES (?,?,?,?,?,?)`,
        [empresa_id, contraparte, monto,
         b.fecha || new Date().toISOString().slice(0, 10),
         (b.nota || '').trim() || null,
         (req.admin && req.admin.usuario) || 'admin']);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Saldar / reabrir un crédito a favor de la empresa (marcar como usado de un golpe)
  app.post('/api/creditos-empresa/:id/saldar', authAdmin, mSaldo, async (req, res) => {
    try {
      const saldar = req.body && req.body.saldar === false ? false : true;
      if (saldar) {
        await portalPool.query(
          `UPDATE creditos_empresa SET estado='saldado', saldado_por=?, saldado_en=NOW() WHERE id=? AND anulado=0`,
          [(req.admin && req.admin.usuario) || 'admin', req.params.id]);
      } else {
        await portalPool.query(
          `UPDATE creditos_empresa SET estado='disponible', saldado_por=NULL, saldado_en=NULL WHERE id=? AND anulado=0`,
          [req.params.id]);
      }
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Anular un crédito a favor de la empresa (solo maestro)
  app.post('/api/creditos-empresa/:id/anular', authAdmin, mSaldo, async (req, res) => {
    try {
      if (!req.admin || !req.admin.maestro)
        return res.status(403).json({ error: 'Solo el administrador maestro puede anular créditos.' });
      await portalPool.query(
        `UPDATE creditos_empresa SET anulado=1, anulado_por=?, anulado_en=NOW() WHERE id=?`,
        [req.admin.usuario, req.params.id]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
};
