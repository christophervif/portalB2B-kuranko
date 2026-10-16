// ═══════════════════════════════════════════════════════════════════════════
//  MÓDULO: Rendimiento (cruce de Ventas e ingresos con Compras y gastos)
//
//  No guarda datos propios. Pide los números a los otros dos módulos para que
//  las tres pestañas muestren siempre lo mismo:
//    · ventas-bi.serieAgrupada → ventas, ingresos, n° ventas, margen FIFO y
//      compras de mercadería por mes y empresa (incluye el histórico del Excel)
//    · gastos.gastosMensuales  → gastos por mes, empresa y categoría
//
//  Cálculos por mes y empresa (estado de resultados SIN IGV; flujo de caja con IGV,
//  porque es el dinero que entra y sale):
//    Ventas netas = ventas sin IGV (÷ 1.18 en las empresas que cobran IGV)
//    Margen bruto = ventas netas × margen % (el margen % sale de las líneas con costo
//                   conocido, con venta y costo sin impuesto, y se aplica a toda la
//                   venta; la "cobertura" dice qué parte de lo vendido tiene costo)
//    Costo de lo vendido = ventas netas − margen bruto
//    Gastos       = gastos de categorías que cuentan en el resultado; en las facturas
//                   de empresas con IGV se descuenta el IGV (crédito fiscal)
//    Utilidad operativa = margen bruto − gastos (antes de impuesto a la renta). Solo
//                   desde el primer mes con gastos anotados DE ESA EMPRESA (el total,
//                   desde que todas anotan); antes no se puede saber y es null.
//    Flujo de caja = cobros − gastos y retiros pagados (por la empresa dueña de la
//                   cuenta que pagó) − mercadería pagada
//    Punto de equilibrio = gastos fijos (costo mensual de los gastos fijos
//                   definidos; un anual cuenta 1/12 por mes) ÷ margen bruto %
//
//  Permiso: módulo 'rendimiento'.
// ═══════════════════════════════════════════════════════════════════════════

const { EMPRESAS_BI } = require('./comunes');

const esMes = v => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(v || ''));
const r2 = n => Math.round((+n || 0) * 100) / 100;
const ultimoDia = mes => { const [a, m] = mes.split('-').map(Number); return new Date(Date.UTC(a, m, 0)).getUTCDate(); };
const mesMenos = (mes, n) => { const [a, m] = mes.split('-').map(Number); return new Date(Date.UTC(a, m - 1 - n, 1)).toISOString().slice(0, 7); };
const CAMPOS_VENTA = ['ventas', 'num_ventas', 'ingresos', 'margen', 'base_margen', 'ingreso_items', 'compras', 'ventas_netas', 'margen_neto', 'base_neta'];
const IGV_DE_FACTURA = 0.18 / 1.18;   // parte de un monto con IGV que es IGV

// Arma la tabla de rendimiento a partir de las filas de ventas y de gastos.
// Función pura (sin base de datos) para poder probarla.
function calcularRendimiento({ meses, filasVentas, gastos, empresa, mesEnCurso, empresasIGV }) {
  const empresas = empresa ? [empresa] : Object.keys(EMPRESAS_BI).map(Number);
  const grupos = empresa ? [String(empresa)] : [...empresas.map(String), 'T'];
  const conIGV = new Set((empresasIGV || Object.keys(EMPRESAS_BI)).map(Number));
  // Primer mes con gastos por empresa (si el módulo de gastos es antiguo, el global)
  const pm = gastos.primer_mes_empresa || null;
  const primerMes = cid => pm ? (pm[cid] || null) : (gastos.primer_mes || null);
  const primerMesGrupo = g => {
    if (g !== 'T') return primerMes(+g);
    const ms = Object.keys(EMPRESAS_BI).map(c => primerMes(+c));
    return ms.some(m => !m) ? null : ms.sort().at(-1);   // el total: desde que TODAS anotan
  };
  const conGastos = (mes, g) => { const p = primerMesGrupo(g); return !!p && mes >= p; };

  const base = () => ({ ...Object.fromEntries(CAMPOS_VENTA.map(c => [c, 0])), gastos: 0, gastos_brutos: 0, no_resultado: 0, fijos: 0, fijos_plantilla: 0,
    merc_caja: 0, gastos_tarjeta: 0, pagos_tarjeta: 0, salidas_cuenta: 0 });
  const celdas = {}; // grupo → mes → valores
  grupos.forEach(g => { celdas[g] = {}; meses.forEach(m => { celdas[g][m] = base(); }); });
  const sumar = (mes, cid, fn) => {
    const destinos = [];
    if (celdas[String(cid)]) destinos.push(String(cid));
    if (celdas.T) destinos.push('T');
    destinos.forEach(g => { if (celdas[g][mes]) fn(celdas[g][mes]); });
  };
  filasVentas.forEach(f => sumar(f.periodo, f.company_id, c => CAMPOS_VENTA.forEach(k => { c[k] += +f[k] || 0; })));
  // Filas antiguas sin montos netos: se usa el bruto
  Object.values(celdas).forEach(porMes => Object.values(porMes).forEach(c => {
    if (!c.ventas_netas && c.ventas) c.ventas_netas = c.ventas;
    if (!c.base_neta && c.base_margen) { c.base_neta = c.base_margen; c.margen_neto = c.margen; }
  }));
  const netoGasto = r => r.total - (conIGV.has(+r.company_id) ? (+r.total_factura || 0) * IGV_DE_FACTURA : 0);
  gastos.por_categoria.forEach(r => sumar(r.mes, r.company_id, c => {
    if (r.en_resultado) { c.gastos += netoGasto(r); c.gastos_brutos += r.total; c.fijos += r.fijos; c.fijos_plantilla += r.fijos_plantilla || 0; }
    else c.no_resultado += r.total;
  }));
  // Caja: lo que salió de cada empresa (cuenta que pagó)
  const porCuenta = Array.isArray(gastos.por_cuenta);
  (gastos.por_cuenta || []).forEach(x => sumar(x.mes, x.company_id, c => { c.salidas_cuenta += x.total; }));
  // Caja: mercadería y gastos con tarjeta en el mes en que realmente sale el dinero
  const conCaja = Array.isArray(gastos.caja);
  (gastos.caja || []).forEach(x => sumar(x.mes, x.company_id, c => {
    c.merc_caja += x.merc_caja; c.gastos_tarjeta += x.gastos_tarjeta; c.pagos_tarjeta += x.pagos_tarjeta; }));

  const resultado = {};
  grupos.forEach(g => {
    resultado[g] = meses.map(mes => {
      const c = celdas[g][mes];
      const margenPct = c.base_neta > 0 ? c.margen_neto / c.base_neta : null;
      const margenBruto = margenPct == null ? null : c.ventas_netas * margenPct;
      const tiene = conGastos(mes, g);
      const utilidad = tiene && margenBruto != null ? margenBruto - c.gastos : null;
      const salidas = porCuenta ? c.salidas_cuenta : c.gastos_brutos + c.no_resultado;
      const gastosCaja = salidas - (conCaja ? c.gastos_tarjeta - c.pagos_tarjeta : 0);
      const comprasCaja = conCaja ? c.merc_caja : c.compras;
      return {
        mes, en_curso: mes === mesEnCurso,
        ventas: r2(c.ventas), ventas_netas: r2(c.ventas_netas), num_ventas: c.num_ventas, ingresos: r2(c.ingresos), compras: r2(c.compras),
        cobertura: c.ingreso_items > 0 ? Math.round(c.base_margen / c.ingreso_items * 1000) / 10 : null,
        margen_pct: margenPct == null ? null : Math.round(margenPct * 1000) / 10,
        margen_bruto: margenBruto == null ? null : r2(margenBruto),
        costo_ventas: margenBruto == null ? null : r2(c.ventas_netas - margenBruto),
        con_gastos: tiene,
        gastos: tiene ? r2(c.gastos) : null,
        no_resultado: tiene ? r2(c.no_resultado) : null,
        fijos: tiene ? r2(c.fijos) : null,
        fijos_plantilla: tiene ? r2(c.fijos_plantilla) : null,
        utilidad: utilidad == null ? null : r2(utilidad),
        utilidad_pct: utilidad != null && c.ventas_netas > 0 ? Math.round(utilidad / c.ventas_netas * 1000) / 10 : null,
        // Flujo de caja: si hay datos de caja, la mercadería y los gastos con tarjeta
        // cuentan cuando se pagan (contado = al comprar; tarjeta = fecha de pago)
        gastos_caja: tiene ? r2(gastosCaja) : null,
        compras_caja: tiene ? r2(comprasCaja) : null,
        flujo: tiene ? r2(c.ingresos - gastosCaja - comprasCaja) : null
      };
    });
  });

  // Gastos por categoría en la ventana (solo meses con gastos) y su % de las ventas netas
  const categorias = {};
  grupos.forEach(g => {
    const mesesG = new Set(meses.filter(m => conGastos(m, g)));
    const ventasG = resultado[g].filter(x => mesesG.has(x.mes)).reduce((a, x) => a + x.ventas_netas, 0);
    const acc = {};
    gastos.por_categoria.forEach(r => {
      if (!mesesG.has(r.mes) || (g !== 'T' && String(r.company_id) !== g)) return;
      const k = r.categoria_id; const a = acc[k] = acc[k] || { categoria: r.categoria || '(sin categoría)', en_resultado: r.en_resultado, total: 0 };
      a.total += r.en_resultado ? netoGasto(r) : r.total;
    });
    categorias[g] = Object.values(acc).map(a => ({ ...a, total: r2(a.total),
      pct_ventas: ventasG > 0 ? Math.round(a.total / ventasG * 1000) / 10 : null })).sort((a, b) => b.total - a.total);
  });

  // Punto de equilibrio: gastos fijos promedio de los últimos 3 meses con gastos
  // (sin contar el mes en curso si hay meses cerrados) ÷ margen bruto %
  // de esos mismos meses.
  const equilibrio = {};
  grupos.forEach(g => {
    const conG = resultado[g].filter(x => x.con_gastos && x.margen_pct != null);
    const cerrados = conG.filter(x => x.mes !== mesEnCurso);
    const ref = (cerrados.length ? cerrados : conG).slice(-3);
    if (!ref.length) { equilibrio[g] = null; return; }
    const fijosPagados = ref.reduce((a, x) => a + x.fijos, 0) / ref.length;
    // Pagos de gastos fijos definidos (se reemplazan por su costo mensual)
    const fijosPlantillaPagados = ref.reduce((a, x) => a + (x.fijos_plantilla || 0), 0) / ref.length;
    const gastosPagados = ref.reduce((a, x) => a + x.gastos, 0) / ref.length;
    // Si hay gastos fijos definidos, se usa su costo MENSUAL (un anual repartido
    // en 12 meses) en vez de lo pagado esos meses, para que un pago anual no
    // dispare ni esconda el punto de equilibrio.
    const fm = gastos.fijos_mensuales || {};
    const usaDefinidos = (gastos.fijos_definidos || 0) > 0;
    const fijosDefinidos = g === 'T' ? Object.values(fm).reduce((a, v) => a + v, 0) : (fm[g] || 0);
    // fijos = costo mensual de los definidos + fijos marcados a mano sin definición
    const fijos = usaDefinidos ? fijosDefinidos + Math.max(0, fijosPagados - fijosPlantillaPagados) : fijosPagados;
    const gastosProm = usaDefinidos ? Math.max(0, gastosPagados - fijosPlantillaPagados) + fijosDefinidos : gastosPagados;
    const ventas = ref.reduce((a, x) => a + x.ventas_netas, 0) / ref.length;
    const mb = ref.reduce((a, x) => a + x.margen_bruto, 0);
    const vt = ref.reduce((a, x) => a + x.ventas_netas, 0);
    const pct = vt > 0 ? mb / vt : null;
    equilibrio[g] = {
      meses: ref.map(x => x.mes), fijos_prom: r2(fijos), gastos_prom: r2(gastosProm), ventas_prom: r2(ventas),
      fijos_origen: usaDefinidos ? 'definidos' : 'pagados', fijos_usd_sin_tc: !!gastos.fijos_usd_sin_tc,
      margen_pct: pct == null ? null : Math.round(pct * 1000) / 10,
      ventas_equilibrio_fijos: pct > 0 ? r2(fijos / pct) : null,
      ventas_equilibrio_total: pct > 0 ? r2(gastosProm / pct) : null
    };
  });

  // Lo pagado entre empresas en la ventana y el saldo neto
  const entre = {};
  gastos.entre.forEach(e => { const k = e.pagadora + '>' + e.beneficiaria; entre[k] = (entre[k] || 0) + e.total; });
  return {
    meses, grupos, resultado, categorias, equilibrio,
    primer_mes_gastos: gastos.primer_mes || null,
    primer_mes_grupo: Object.fromEntries(grupos.map(g => [g, primerMesGrupo(g)])),
    empresas_sin_gastos: Object.keys(EMPRESAS_BI).map(Number).filter(c => !primerMes(c)),
    entre_empresas: Object.entries(entre).map(([k, total]) => { const [p, b] = k.split('>').map(Number); return { pagadora: p, beneficiaria: b, total: r2(total) }; })
  };
}

module.exports = function registrarRendimiento({ app, authAdmin, requiereModulo, serieAgrupada, gastosMensuales }) {
  const mRend = requiereModulo('rendimiento');

  app.get('/api/rendimiento', authAdmin, mRend, async (req, res) => {
    try {
      const hoy = new Date(Date.now() - 5 * 3600e3).toISOString().slice(0, 7);
      const hasta = esMes(req.query.hasta) ? req.query.hasta : hoy;
      const n = [6, 12, 24, 36].includes(+req.query.meses) ? +req.query.meses : 12;
      const meses = []; for (let i = n - 1; i >= 0; i--) meses.push(mesMenos(hasta, i));
      const desde = meses[0] + '-01', fin = hasta + '-' + ultimoDia(hasta);
      const empresa = EMPRESAS_BI[parseInt(req.query.empresa, 10)] ? parseInt(req.query.empresa, 10) : null;
      const [serie, gastos] = await Promise.all([
        serieAgrupada({ desde, hasta: fin, empresa, agrupar: 'mes' }),
        gastosMensuales({ desde, hasta: fin, empresa })
      ]);
      const cfg = serie.config_igv || null;
      const r = calcularRendimiento({ meses, filasVentas: serie.filas, gastos, empresa, mesEnCurso: hoy,
        empresasIGV: cfg ? cfg.empresas_igv : null });
      res.json({ ...r, hasta, mes_en_curso: meses.includes(hoy) ? hoy : null, config_igv: cfg,
        empresas: Object.entries(EMPRESAS_BI).map(([id, nombre]) => ({ id: +id, nombre })),
        historico: serie.historico });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  // Mes en curso día a día: ingresos vs egresos acumulados y proyección al cierre
  app.get('/api/rendimiento/mes', authAdmin, mRend, async (req, res) => {
    try {
      if (!gastosMensuales.mesEnCurso) return res.status(501).json({ error: 'Actualiza modulos/gastos.js' });
      res.json(await gastosMensuales.mesEnCurso({ empresa: req.query.empresa }));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return { _test: { calcularRendimiento } };
};
