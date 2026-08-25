// ═══════════════════════════════════════════════════════════════════════════
//  MÓDULO: CRM Kommo
//  Pipeline, tareas y conversión de leads desde Kommo.
//  Este archivo NO es un servidor aparte: es un módulo que el index.js principal
//  "carga" pasándole las piezas compartidas (app, pools, permisos, helpers).
//  Así comparte login, base de datos y sesión con todo el portal.
// ═══════════════════════════════════════════════════════════════════════════

const https = require('https');

// Estados de Kommo (ganado / perdido)
const KOMMO_GANADO = 142, KOMMO_PERDIDO = 143;

// Llamada a la API de Kommo (usa las variables de entorno KOMMO_DOMAIN y KOMMO_TOKEN)
const kommoFetch = (endpoint) => new Promise((resolve, reject) => {
  const req = https.request({
    hostname: process.env.KOMMO_DOMAIN, path: `/api/v4/${endpoint}`, family: 4,
    headers: { 'Authorization': `Bearer ${process.env.KOMMO_TOKEN}` }
  }, (r) => {
    let d = ''; r.on('data', c => d += c);
    r.on('end', () => { if (!d.trim()) return resolve({}); try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('Kommo parse ' + r.statusCode)); } });
  });
  req.on('error', reject); req.end();
});

/**
 * Registra las rutas del CRM Kommo.
 * @param {object} deps - piezas compartidas del portal
 *   app        : la app de Express
 *   authAdmin  : middleware de autenticación admin
 *   mCrm       : middleware que exige el módulo 'crm'
 *   prodPool   : conexión a la base del ERP (solo lectura)
 *   VV         : constante SQL de estados de venta válidos
 */
module.exports = function registrarCrmKommo({ app, authAdmin, mCrm, prodPool, VV }) {

  app.get('/api/kommo/pipeline', authAdmin, mCrm, async (req, res) => {
    try {
      const [pl, ld] = await Promise.all([kommoFetch('leads/pipelines?limit=50'), kommoFetch('leads?limit=250')]);
      const pipes = pl._embedded?.pipelines || [], leads = ld._embedded?.leads || [];
      res.json(pipes.map(pipe => {
        const statuses = pipe._embedded?.statuses ? Object.values(pipe._embedded.statuses) : [];
        const pl2 = leads.filter(l => l.pipeline_id === pipe.id);
        const ganados = pl2.filter(l => l.status_id === KOMMO_GANADO);
        const perdidos = pl2.filter(l => l.status_id === KOMMO_PERDIDO);
        const activos = pl2.filter(l => l.status_id !== KOMMO_GANADO && l.status_id !== KOMMO_PERDIDO);
        return {
          nombre: pipe.name, total_leads: pl2.length, activos: activos.length,
          ganados: ganados.length, perdidos: perdidos.length,
          valor_activo: activos.reduce((s, l) => s + (l.price || 0), 0),
          tasa_conversion: pl2.length > 0 ? ((ganados.length / pl2.length) * 100).toFixed(1) : '0.0',
          etapas: statuses.filter(s => s.id !== KOMMO_GANADO && s.id !== KOMMO_PERDIDO)
            .map(s => ({ nombre: s.name, cantidad: pl2.filter(l => l.status_id === s.id).length }))
        };
      }));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/kommo/tareas', authAdmin, mCrm, async (req, res) => {
    try {
      const ahora = Math.floor(Date.now() / 1000);
      const data = await kommoFetch('tasks?limit=250');
      const t = data._embedded?.tasks || [];
      const venc = t.filter(x => x.complete_till < ahora && !x.is_completed);
      const hoy = t.filter(x => { const d = new Date(x.complete_till * 1000), n = new Date(); return d.toDateString() === n.toDateString() && !x.is_completed; });
      res.json({
        total_pendientes: t.filter(x => !x.is_completed).length, vencidas: venc.length, hoy: hoy.length,
        proximas: t.filter(x => x.complete_till > ahora && !x.is_completed && !hoy.includes(x)).length,
        detalle_vencidas: venc.sort((a, b) => a.complete_till - b.complete_till).slice(0, 15)
          .map(x => ({ texto: x.text, vencio: new Date(x.complete_till * 1000).toLocaleDateString('es-PE') }))
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/kommo/conversion', authAdmin, mCrm, async (req, res) => {
    try {
      const data = await kommoFetch('contacts?limit=250');
      const contactos = data._embedded?.contacts || [];
      const [[conv]] = await prodPool.query(`
        SELECT COUNT(DISTINCT p.kommo_id) AS con_venta FROM parties p
        JOIN sales s ON s.customer_id = p.id
        WHERE p.kommo_id IS NOT NULL AND s.deleted_at IS NULL AND s.status IN ${VV}`);
      const [[sinv]] = await prodPool.query(`
        SELECT COUNT(*) AS sin_venta FROM parties p WHERE p.kommo_id IS NOT NULL
        AND p.id NOT IN (SELECT DISTINCT customer_id FROM sales WHERE deleted_at IS NULL AND status IN ${VV})`);
      res.json({
        total_contactos: contactos.length, con_venta: conv.con_venta, sin_venta: sinv.sin_venta,
        tasa_conversion: contactos.length > 0 ? ((conv.con_venta / contactos.length) * 100).toFixed(1) : '0.0'
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

};
