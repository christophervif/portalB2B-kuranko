// ═══════════════════════════════════════════════════════════════════════════
//  MÓDULO: Conciliación de pagos online
//  Compara los pagos registrados en el sistema contra un Google Sheet publicado
//  (CSV) con los pagos online, agrupando por empresa y canal.
//  La URL del Sheet viene de la variable de entorno SHEET_CONCILIACION_URL.
// ═══════════════════════════════════════════════════════════════════════════

module.exports = function registrarConciliacion({ app, authAdmin, mResumen, prodPool, VV }) {

  // Normaliza una fecha del sheet (dd/mm/yy o dd/mm/yyyy) a YYYY-MM-DD
  function fechaSheetISO(str) {
    if (!str) return null;
    const s = str.trim();
    const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (!m) return null;
    let [, d, mes, a] = m;
    if (a.length === 2) a = '20' + a;
    return `${a}-${String(mes).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  // ── CONCILIACIÓN DE CAJA: pagos online desde Google Sheet ──
  // Lee un CSV publicado del Sheet, filtra por Fecha voucher y suma por empresa + canal.
  const SHEET_CSV_URL = process.env.SHEET_CONCILIACION_URL ||
    'https://docs.google.com/spreadsheets/d/e/2PACX-1vTKw8_uRi40xblPfuwYamFtsb_NsYx8BS9RdOfTENIu5BOSGPDAXu0RPOAjbAIN7_CXuOWQnNjW3aqn/pub?gid=0&single=true&output=csv';

  // Parser CSV simple que respeta comillas
  function parseCSV(texto) {
    const filas = [];
    let campo = '', fila = [], enComillas = false;
    for (let i = 0; i < texto.length; i++) {
      const c = texto[i];
      if (enComillas) {
        if (c === '"' && texto[i + 1] === '"') { campo += '"'; i++; }
        else if (c === '"') enComillas = false;
        else campo += c;
      } else {
        if (c === '"') enComillas = true;
        else if (c === ',') { fila.push(campo); campo = ''; }
        else if (c === '\n') { fila.push(campo); filas.push(fila); fila = []; campo = ''; }
        else if (c === '\r') { /* ignorar */ }
        else campo += c;
      }
    }
    if (campo !== '' || fila.length) { fila.push(campo); filas.push(fila); }
    return filas;
  }

  app.get('/api/conciliacion-sheet', authAdmin, mResumen, async (req, res) => {
    try {
      const { desde, hasta } = req.query;
      const r = await fetch(SHEET_CSV_URL);
      if (!r.ok) return res.status(502).json({ error: 'No se pudo leer el Google Sheet (código ' + r.status + ')' });
      const texto = await r.text();
      const filas = parseCSV(texto);
      if (!filas.length) return res.json({ filas: [], porEmpresaCanal: {}, total: 0 });

      // Detectar columnas por nombre de cabecera
      const cab = filas[0].map(x => (x || '').trim());
      const idx = (nombre) => cab.findIndex(c => c.toLowerCase() === nombre.toLowerCase());
      const iEmpresa = idx('Empresa');
      const iCanal = idx('Canal');
      const iFechaV = idx('Fecha voucher');
      const iTotal = idx('Total (S/)');
      if (iEmpresa < 0 || iCanal < 0 || iTotal < 0) {
        return res.status(500).json({ error: 'El Sheet no tiene las columnas esperadas (Empresa, Canal, Total (S/)).' });
      }

      const porEmpresaCanal = {};
      let total = 0;
      const detalle = [];
      for (let i = 1; i < filas.length; i++) {
        const f = filas[i];
        if (!f || f.length < 2) continue;
        const empresa = (f[iEmpresa] || '').trim();
        const canal = (f[iCanal] || '').trim();
        const fechaISO = fechaSheetISO(f[iFechaV] || '');
        const monto = parseFloat((f[iTotal] || '0').toString().replace(/[^\d.-]/g, '')) || 0;
        if (!empresa || !canal) continue;
        // Filtro por fecha voucher
        if (desde && (!fechaISO || fechaISO < desde)) continue;
        if (hasta && (!fechaISO || fechaISO > hasta)) continue;
        const clave = empresa + '|||' + canal;
        porEmpresaCanal[clave] = (porEmpresaCanal[clave] || 0) + monto;
        total += monto;
        detalle.push({ empresa, canal, fecha: fechaISO, monto });
      }
      res.json({ porEmpresaCanal, total, num: detalle.length, detalle });
    } catch (e) {
      res.status(500).json({ error: 'Error al leer el Sheet: ' + e.message });
    }
  });


  app.get('/api/conciliacion-sistema', authAdmin, mResumen, async (req, res) => {
    const { desde, hasta } = req.query;
    const f = desde && hasta ? `AND sp.paid_at BETWEEN '${desde}' AND '${hasta} 23:59:59'`
      : `AND sp.paid_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)`;
    try {
      const [rows] = await prodPool.query(`
        SELECT COALESCE(ba.party_id, s.company_id) AS company_id,
          ci.code AS metodo_code, ci.name AS metodo_nombre,
          COUNT(*) AS cantidad, COALESCE(SUM(sp.amount),0) AS total
        FROM sale_payments sp
        LEFT JOIN catalog_items ci ON ci.id = sp.payment_method_id
        LEFT JOIN sales s ON s.id = sp.sale_id
        LEFT JOIN bank_accounts ba ON ba.id = sp.bank_account_id
        WHERE sp.voided_at IS NULL ${f}
        GROUP BY COALESCE(ba.party_id, s.company_id), ci.code, ci.name`);
      res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });


};
