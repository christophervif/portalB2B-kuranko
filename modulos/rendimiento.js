// ═══════════════════════════════════════════════════════════════════════════
//  MÓDULO: Rendimiento (cruce de Ventas e ingresos con Compras y gastos)
//
//  No guarda datos propios. Pide los números a los otros dos módulos para que
//  las tres pestañas muestren siempre lo mismo:
//    · ventas-bi.serieAgrupada → ventas, ingresos, n° ventas, margen FIFO y
//      compras de mercadería por mes y empresa (incluye el histórico del Excel)
//    · gastos.gastosMensuales  → gastos por mes, empresa y categoría
//
//  Cálculos por mes y empresa:
//    Margen bruto = ventas × margen % (el margen % sale de las líneas con costo
//                   conocido y se aplica a toda la venta; la "cobertura" dice
//                   qué parte de lo vendido tiene costo conocido)
//    Costo de lo vendido = ventas − margen bruto
//    Gastos       = gastos de categorías que cuentan en el resultado
//    Utilidad neta = margen bruto − gastos (solo desde el primer mes con gastos
//                   anotados; antes no se puede saber y se devuelve null)
//    Flujo de caja = ingresos cobrados − gastos − retiros/préstamos − compras
//                   de mercadería
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
const CAMPOS_VENTA = ['ventas', 'num_ventas', 'ingresos', 'margen', 'base_margen', 'ingreso_items', 'compras'];

// Arma la tabla de rendimiento a partir de las filas de ventas y de gastos.
// Función pura (sin base de datos) para poder probarla.
function calcularRendimiento({ meses, filasVentas, gastos, empresa, mesEnCurso }) {
  const empresas = empresa ? [empresa] : Object.keys(EMPRESAS_BI).map(Number);
  const grupos = empresa ? [String(empresa)] : [...empresas.map(String), 'T'];
  const primerMesGastos = gastos.primer_mes || null;
  const conGastos = mes => !!primerMesGastos && mes >= primerMesGastos;

  const base = () => ({ ...Object.fromEntries(CAMPOS_VENTA.map(c => [c, 0])), gastos: 0, no_resultado: 0, fijos: 0, fijos_plantilla: 0 });
  const celdas = {}; // grupo → mes → valores
  grupos.forEach(g => { celdas[g] = {}; meses.forEach(m => { celdas[g][m] = base(); }); });
  const sumar = (mes, cid, fn) => {
    const destinos = [];
    if (celdas[String(cid)]) destinos.push(String(cid));
    if (celdas.T) destinos.push('T');
    destinos.forEach(g => { if (celdas[g][mes]) fn(celdas[g][mes]); });
  };
  filasVentas.forEach(f => sumar(f.periodo, f.company_id, c => CAMPOS_VENTA.forEach(k => { c[k] += +f[k] || 0; })));
  gastos.por_categoria.forEach(r => sumar(r.mes, r.company_id, c => {
    if (r.en_resultado) { c.gastos += r.total; c.fijos += r.fijos; c.fijos_plantilla += r.fijos_plantilla || 0; }
    else c.no_resultado += r.total;
  }));

  const resultado = {};
  grupos.forEach(g => {
    resultado[g] = meses.map(mes => {
      const c = celdas[g][mes];
      const margenPct = c.base_margen > 0 ? c.margen / c.base_margen : null;
      const margenBruto = margenPct == null ? null : c.ventas * margenPct;
      const tiene = conGastos(mes);
      const utilidad = tiene && margenBruto != null ? margenBruto - c.gastos : null;
      return {
        mes, ventas: r2(c.ventas), num_ventas: c.num_ventas, ingresos: r2(c.ingresos), compras: r2(c.compras),
        cobertura: c.ingreso_items > 0 ? Math.round(c.base_margen / c.ingreso_items * 1000) / 10 : null,
        margen_pct: margenPct == null ? null : Math.round(margenPct * 1000) / 10,
        margen_bruto: margenBruto == null ? null : r2(margenBruto),
        costo_ventas: margenBruto == null ? null : r2(c.ventas - margenBruto),
        con_gastos: tiene,
        gastos: tiene ? r2(c.gastos) : null,
        no_resultado: tiene ? r2(c.no_resultado) : null,
        fijos: tiene ? r2(c.fijos) : null,
        fijos_plantilla: tiene ? r2(c.fijos_plantilla) : null,
        utilidad: utilidad == null ? null : r2(utilidad),
        utilidad_pct: utilidad != null && c.ventas > 0 ? Math.round(utilidad / c.ventas * 1000) / 10 : null,
        flujo: tiene ? r2(c.ingresos - c.gastos - c.no_resultado - c.compras) : null
      };
    });
  });

  // Gastos por categoría en la ventana (solo meses con gastos) y su % de las ventas
  const categorias = {};
  grupos.forEach(g => {
    const mesesG = new Set(meses.filter(conGastos));
    const ventasG = resultado[g].filter(x => mesesG.has(x.mes)).reduce((a, x) => a + x.ventas, 0);
    const acc = {};
    gastos.por_categoria.forEach(r => {
      if (!mesesG.has(r.mes) || (g !== 'T' && String(r.company_id) !== g)) return;
      const k = r.categoria_id; const a = acc[k] = acc[k] || { categoria: r.categoria || '(sin categoría)', en_resultado: r.en_resultado, total: 0 };
      a.total += r.total;
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
    const ventas = ref.reduce((a, x) => a + x.ventas, 0) / ref.length;
    const mb = ref.reduce((a, x) => a + x.margen_bruto, 0);
    const vt = ref.reduce((a, x) => a + x.ventas, 0);
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
    meses, grupos, resultado, categorias, equilibrio, primer_mes_gastos: primerMesGastos,
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
      const r = calcularRendimiento({ meses, filasVentas: serie.filas, gastos, empresa, mesEnCurso: hoy });
      res.json({ ...r, hasta, mes_en_curso: hasta === hoy ? hoy : null,
        empresas: Object.entries(EMPRESAS_BI).map(([id, nombre]) => ({ id: +id, nombre })),
        historico: serie.historico });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  return { _test: { calcularRendimiento } };
};
