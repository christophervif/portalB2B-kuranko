// ═══════════════════════════════════════════════════════════════════════════
//  MÓDULO: Accesos (usuarios del panel admin)
//  Lectura de los accesos admin definidos en Railway (solo el maestro).
//  La gestión de clientes del portal se movió a modulos/clientes-gestion.js.
// ═══════════════════════════════════════════════════════════════════════════

module.exports = function registrarAccesos({
  app, authAdmin, requiereModulo, soloMaestro,
  prodPool, portalPool, JWT_SECRET, MODULOS_ADMIN, leerAdminsSecundarios
}) {

  // ── Gestión de clientes del portal (crear/activar/vincular accesos, reset de
  //    clave, ver como cliente, RUC agrupados) → modulos/clientes-gestion.js ──

  // ── Módulo Contabilidad (kardex + reporte de pagos) en modulos/contabilidad.js ──
  // Se carga más abajo, donde VV ya está definido.

  // ── Sincronización (modulos/sincronizacion.js) y Auditoría (modulos/auditoria.js) ──
  // Se cargan más abajo junto a los otros módulos.

  // ─── Ver accesos (SOLO admin maestro) — lectura de las variables de Railway ──
  app.get('/admin/accesos', authAdmin, soloMaestro, async (req, res) => {
    const secundarios = leerAdminsSecundarios();
    res.json({
      modulos_disponibles: MODULOS_ADMIN,
      usuarios: secundarios.map(a => ({ username: a.usuario, modulos: a.modulos }))
    });
  });



};
