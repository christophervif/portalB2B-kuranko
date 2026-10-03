// ═══════════════════════════════════════════════════════════════════════════
//  MÓDULO: Clientes BI — quiénes compran, quiénes vuelven y quiénes se van
//  Backend aquí; frontend propio en public/clientes-bi.html (iframe en el panel).
//  (Cuentas por cobrar → modulos/cuentas-cobrar.js · Créditos → modulos/creditos.js)
//
//  Endpoints
//    GET /api/clientes-bi        (permiso clientes_bi)  → KPIs, retención, evolución
//                                 mensual, estados, top del período y lista de clientes
//    GET /api/clientes-bi-excel  (permiso clientes_bi)  → lo mismo en Excel
//    GET /api/tipo-cliente       (permiso resumen)      → B2B/B2C para "Ventas e ingresos"
//
//  Filtros (query)
//    desde, hasta  período a analizar (AAAA-MM-DD). Por defecto: últimos 12 meses.
//    empresa       '' (todas) | company_id conocido (EMPRESAS_BI)
//    tipo          '' (todos) | b2b (empresas) | b2c (personas)
//    umbral        días sin comprar para "en riesgo": 60 | 90 (def.) | 120 | 180
//    genericos     excluir (def.) | incluir  — "clientes varios", DNI 00000000, etc.
//
//  Reglas
//  · Ventas válidas: status IN VV y sin borrar (igual que el resto del panel).
//  · Un cliente = mismo RUC/DNI (une duplicados del ERP); sin documento → su id.
//    Empresas con varios RUC agrupados en Gestión de clientes (ej. Puntobike SAC
//    + Frisancho Pereyra Sadith) cuentan como un solo cliente.
//  · "Compra" = día distinto con venta. Dos ventas el mismo día cuentan como una
//    visita (antes un cliente con 2 boletas el mismo día salía "recurrente").
//  · Estado (al día de referencia = "hasta", o hoy si "hasta" es futuro):
//      nuevo      su primera compra cae dentro del período
//      activo     compró hace menos de U días (U = umbral)
//      en_riesgo  2+ compras, sin comprar hace U…364 días
//      no_volvio  1 sola compra, sin comprar hace U…364 días
//      perdido    sin comprar hace 365+ días
//    Además "atrasado": 3+ compras y lleva más del doble de su ritmo habitual sin
//    comprar (aunque aún no llegue a U). Sirve para avisar antes.
//  · Retención = de los clientes que compraron en el período ANTERIOR (mismo largo),
//    qué % volvió a comprar en este período. (La versión anterior medía la distancia
//    entre la primera y la última compra de toda la historia, que no es retención.)
//  · Montos = sales.total (con IGV), igual que "Ventas e ingresos".
// ═══════════════════════════════════════════════════════════════════════════

const { EMPRESAS_BI, rango, nombreTrazable, cabeceraExcel } = require('./comunes');

const UMBRALES = [60, 90, 120, 180];
const DEF_UMBRAL = 90;
const PERDIDO_DIAS = 365;
const MAX_MESES = 24;
const DIA = 864e5;
const ESTADOS = ['nuevo', 'activo', 'en_riesgo', 'no_volvio', 'perdido'];

const esFecha = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const aUTC = f => Date.UTC(+f.slice(0, 4), +f.slice(5, 7) - 1, +f.slice(8, 10));
const deUTC = t => new Date(t).toISOString().slice(0, 10);
const sumarDias = (f, n) => deUTC(aUTC(f) + n * DIA);
const difDias = (a, b) => Math.round((aUTC(a) - aUTC(b)) / DIA);
const hoyLima = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
const r1 = n => Math.round(n * 10) / 10;
const r2 = n => Math.round(n * 100) / 100;
const pct = (a, b) => (b > 0 ? r1((a / b) * 100) : null);

// ── Clientes genéricos ("clientes varios", público general, DNI de relleno) ──
const DOCS_GENERICOS = new Set(['', '0', '00000000', '000000000', '00000000000', '11111111', '99999999', '99999999999', '12345678']);
const RE_NOMBRE_GENERICO = /\b(clientes?\s+varios|varios|p[uú]blico(\s+en)?\s+general|cliente\s+general|consumidor\s+final|sin\s+nombre|an[oó]nimo)\b/i;
const IDS_GENERICOS = new Set(String(process.env.CLIENTES_GENERICOS || '').split(',').map(x => x.trim()).filter(Boolean));
const limpiarDoc = d => String(d || '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
function esGenerico(p) {
  if (IDS_GENERICOS.has(String(p.id))) return true;
  const doc = limpiarDoc(p.document_number);
  if (doc && (DOCS_GENERICOS.has(doc) || /^(\d)\1+$/.test(doc))) return true;
  return RE_NOMBRE_GENERICO.test(p.nombre || '');
}
const nombreParte = p => ((p.is_company ? p.business_name : `${p.first_name || ''} ${p.last_name || ''}`) || '').replace(/\s+/g, ' ').trim();

function leerFiltros(q, hoy) {
  q = q || {}; hoy = hoy || hoyLima();
  let hasta = esFecha(q.hasta) ? q.hasta : hoy;
  let desde = esFecha(q.desde) ? q.desde : sumarDias(hasta, -364);
  if (desde > hasta) [desde, hasta] = [hasta, desde];
  const emp = parseInt(q.empresa, 10);
  const u = Number(q.umbral);
  return {
    desde, hasta,
    empresa: EMPRESAS_BI[emp] ? emp : '',
    tipo: q.tipo === 'b2b' || q.tipo === 'b2c' ? q.tipo : '',
    umbral: UMBRALES.includes(u) ? u : DEF_UMBRAL,
    genericos: q.genericos === 'incluir' ? 'incluir' : 'excluir'
  };
}

// Meses (AAAA-MM) entre dos fechas, como máximo los últimos MAX_MESES
function mesesEntre(desde, hasta) {
  const out = []; let a = +desde.slice(0, 4), m = +desde.slice(5, 7);
  const fa = +hasta.slice(0, 4), fm = +hasta.slice(5, 7);
  while (a < fa || (a === fa && m <= fm)) { out.push(`${a}-${String(m).padStart(2, '0')}`); if (++m > 12) { m = 1; a++; } }
  return out.slice(-MAX_MESES);
}

// ═══ Cálculo puro (sin base de datos) — se exporta para pruebas ═══
//  ventas: [{ customer_id, company_id, total, dia:'AAAA-MM-DD' }]  (todas ≤ hasta)
//  partes: [{ id, is_company, business_name, first_name, last_name, document_number, email, phone }]
//  unir:   Map customer_id → customer_id principal (RUC agrupados en Gestión de clientes)
function calcularClientes(ventas, partes, f, hoy, unir) {
  hoy = hoy || hoyLima();
  const ref = f.hasta < hoy ? f.hasta : hoy;               // día de referencia para "días sin comprar"
  const largo = difDias(f.hasta, f.desde) + 1;
  const prevHasta = sumarDias(f.desde, -1), prevDesde = sumarDias(f.desde, -largo);

  // Partes → grupo (RUC/DNI o id)
  const grupoDe = {}; const grupos = {};
  // Un RUC agrupado arrastra también a otras fichas del ERP con el mismo documento
  const grupoDeDoc = new Map();
  if (unir) partes.forEach(p => {
    const doc = limpiarDoc(p.document_number);
    if (doc.length >= 8 && unir.has(Number(p.id))) grupoDeDoc.set(doc, unir.get(Number(p.id)));
  });
  partes.forEach(p => {
    const nombre = nombreParte(p);
    const doc = limpiarDoc(p.document_number);
    const gen = esGenerico({ ...p, nombre });
    const principal = unir ? (unir.has(Number(p.id)) ? unir.get(Number(p.id)) : grupoDeDoc.get(doc)) : undefined;
    const clave = principal != null ? 'grp:' + principal
      : gen ? 'gen:' + p.id : (doc.length >= 8 ? 'doc:' + doc : 'id:' + p.id);
    grupoDe[p.id] = clave;
    const g = grupos[clave] || (grupos[clave] = {
      clave, ids: [], nombre: '', doc: p.document_number || '', tipo: p.is_company ? 'b2b' : 'b2c',
      email: '', telefono: '', generico: gen, compras: {}, empresas: new Set()
    });
    g.ids.push(p.id);
    if (principal != null && Number(p.id) === principal) { if (nombre) g.nombre = nombre; g.doc = p.document_number || g.doc; g.principal = true; }
    else if (!g.principal && (!g.nombre || (nombre && nombre.length > g.nombre.length))) g.nombre = nombre;
    if (p.is_company) g.tipo = 'b2b';
    if (!g.email && p.email) g.email = p.email;
    if (!g.telefono && p.phone) g.telefono = p.phone;
  });

  // Ventas → compras por día
  ventas.forEach(v => {
    const clave = grupoDe[v.customer_id] || ('id:' + v.customer_id);
    const g = grupos[clave] || (grupos[clave] = {
      clave, ids: [v.customer_id], nombre: '', doc: '', tipo: 'b2c', email: '', telefono: '', generico: false, compras: {}, empresas: new Set()
    });
    const d = g.compras[v.dia] || (g.compras[v.dia] = { n: 0, monto: 0 });
    d.n++; d.monto += Number(v.total) || 0;
    if (v.company_id != null) g.empresas.add(Number(v.company_id));
  });

  const genericosExcluidos = { clientes: 0, ventas: 0, monto: 0 };
  const clientes = []; const comprasDe = new Map();
  Object.values(grupos).forEach(g => {
    const dias = Object.keys(g.compras).sort();
    if (!dias.length) return;
    if (f.tipo && g.tipo !== f.tipo) return;
    let hv = 0, hm = 0, pv = 0, pm = 0, av = 0, am = 0, pdias = 0, adias = 0;
    dias.forEach(d => {
      const c = g.compras[d]; hv += c.n; hm += c.monto;
      if (d >= f.desde && d <= f.hasta) { pv += c.n; pm += c.monto; pdias++; }
      else if (d >= prevDesde && d <= prevHasta) { av += c.n; am += c.monto; adias++; }
    });
    if (g.generico && f.genericos === 'excluir') {
      if (pv) { genericosExcluidos.clientes++; genericosExcluidos.ventas += pv; genericosExcluidos.monto += pm; }
      return;
    }
    const primera = dias[0], ultima = dias[dias.length - 1];
    const visitas = dias.length;
    const sinComprar = Math.max(0, difDias(ref, ultima));
    const ritmo = visitas >= 2 ? Math.round(difDias(ultima, primera) / (visitas - 1)) : null;
    let estado;
    if (primera >= f.desde && primera <= f.hasta) estado = 'nuevo';
    else if (sinComprar >= PERDIDO_DIAS) estado = 'perdido';
    else if (sinComprar < f.umbral) estado = 'activo';
    else estado = visitas >= 2 ? 'en_riesgo' : 'no_volvio';
    const atrasado = estado !== 'perdido' && visitas >= 3 && ritmo != null && sinComprar >= 30 && sinComprar > 2 * Math.max(ritmo, 7);
    const cli = {
      id: g.ids[0], ids: g.ids, cliente: g.nombre || `Cliente ${g.ids[0]}`, doc: g.doc || '', tipo: g.tipo,
      email: g.email, telefono: g.telefono, generico: g.generico,
      empresas: [...g.empresas].map(e => EMPRESAS_BI[e] || `Empresa ${e}`),
      estado, atrasado,
      per_ventas: pv, per_compras: pdias, per_monto: r2(pm), per_ticket: pv ? r2(pm / pv) : 0,
      ant_ventas: av, ant_monto: r2(am),
      var_monto: am > 0 ? r1(((pm - am) / am) * 100) : null,
      hist_ventas: hv, hist_compras: visitas, hist_monto: r2(hm), hist_ticket: r2(hm / hv),
      primera, ultima, dias_sin_comprar: sinComprar, ritmo_dias: ritmo,
      atraso: ritmo ? r1(sinComprar / Math.max(ritmo, 1)) : null
    };
    clientes.push(cli); comprasDe.set(cli, g.compras);
  });

  // ── KPIs del período ──
  const enPer = clientes.filter(c => c.per_ventas > 0);
  const enAnt = clientes.filter(c => c.ant_ventas > 0);
  const nuevos = clientes.filter(c => c.estado === 'nuevo');
  const volvieron = enPer.filter(c => c.estado !== 'nuevo');
  const retenidos = enAnt.filter(c => c.per_ventas > 0);
  const montoPer = enPer.reduce((s, c) => s + c.per_monto, 0);
  const ventasPer = enPer.reduce((s, c) => s + c.per_ventas, 0);
  const montoAnt = enAnt.reduce((s, c) => s + c.ant_monto, 0);
  const nuevosRecompra = nuevos.filter(c => c.hist_compras >= 2).length;

  // Ranking del período (con % del total y % acumulado → concentración / Pareto)
  const top = [...enPer].sort((a, b) => b.per_monto - a.per_monto);
  let acum = 0, n80 = 0;
  top.forEach((c, i) => {
    acum += c.per_monto;
    c.rank = i + 1; c.part = pct(c.per_monto, montoPer); c.part_acum = pct(acum, montoPer);
    if (!n80 && montoPer > 0 && acum >= montoPer * 0.8) n80 = i + 1;
  });
  const top10 = top.slice(0, 10).reduce((s, c) => s + c.per_monto, 0);

  const kpis = {
    activos: enPer.length, activos_ant: enAnt.length,
    nuevos: nuevos.length, volvieron: volvieron.length,
    ventas: ventasPer, monto: r2(montoPer), monto_ant: r2(montoAnt),
    var_monto: montoAnt > 0 ? r1(((montoPer - montoAnt) / montoAnt) * 100) : null,
    ticket: ventasPer ? r2(montoPer / ventasPer) : 0,
    monto_por_cliente: enPer.length ? r2(montoPer / enPer.length) : 0,
    retencion: pct(retenidos.length, enAnt.length), retenidos: retenidos.length,
    recompra_nuevos: pct(nuevosRecompra, nuevos.length), nuevos_recompra: nuevosRecompra,
    recurrencia_hist: pct(clientes.filter(c => c.hist_compras >= 2).length, clientes.length),
    clientes_hist: clientes.length,
    concentracion_top10: pct(top10, montoPer), clientes_80: n80,
    riesgo_monto_hist: r2(clientes.filter(c => c.estado === 'en_riesgo').reduce((s, c) => s + c.hist_monto, 0))
  };

  // ── Estados ──
  const estados = {};
  ESTADOS.forEach(e => { estados[e] = { clientes: 0, hist_monto: 0, per_monto: 0 }; });
  clientes.forEach(c => { const e = estados[c.estado]; e.clientes++; e.hist_monto += c.hist_monto; e.per_monto += c.per_monto; });
  ESTADOS.forEach(e => { estados[e].hist_monto = r2(estados[e].hist_monto); estados[e].per_monto = r2(estados[e].per_monto); });
  const atrasados = clientes.filter(c => c.atrasado && c.estado === 'activo').length;

  // ── B2B / B2C en el período ──
  const porTipo = ['b2b', 'b2c'].map(t => {
    const l = enPer.filter(c => c.tipo === t);
    const m = l.reduce((s, c) => s + c.per_monto, 0), v = l.reduce((s, c) => s + c.per_ventas, 0);
    return { tipo: t, clientes: l.length, ventas: v, monto: r2(m), ticket: v ? r2(m / v) : 0, part: pct(m, montoPer) };
  });

  // ── Evolución mensual: clientes con compra en el mes, nuevos vs. que vuelven ──
  // 12 meses hasta "hasta" (o todo el período si es más largo, máx. 24)
  const ini12 = sumarDias(f.hasta.slice(0, 8) + '01', -1).slice(0, 8) + '01';
  const desdeMes = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].reduce(x => sumarDias(x, -1).slice(0, 8) + '01', ini12);
  const meses = mesesEntre(f.desde < desdeMes ? f.desde : desdeMes, f.hasta);
  const mapaMes = {}; meses.forEach(m => { mapaMes[m] = { mes: m, activos: 0, nuevos: 0, recurrentes: 0, monto: 0 }; });
  clientes.forEach(c => {
    const vistos = new Set();
    Object.entries(comprasDe.get(c)).forEach(([d, x]) => {
      const m = d.slice(0, 7); const mm = mapaMes[m]; if (!mm) return;
      mm.monto += x.monto;
      if (!vistos.has(m)) {
        vistos.add(m); mm.activos++;
        if (c.primera.slice(0, 7) === m) mm.nuevos++; else mm.recurrentes++;
      }
    });
  });
  const mensual = meses.map(m => ({ ...mapaMes[m], monto: r2(mapaMes[m].monto) }));

  // Lista ordenada por lo comprado en el período y luego por historia
  clientes.sort((a, b) => b.per_monto - a.per_monto || b.hist_monto - a.hist_monto);

  return {
    filtros: f, referencia: ref,
    periodo_anterior: { desde: prevDesde, hasta: prevHasta },
    kpis, estados, atrasados, por_tipo: porTipo, mensual,
    genericos_excluidos: { ...genericosExcluidos, monto: r2(genericosExcluidos.monto) },
    clientes
  };
}

module.exports = function registrarClientesBI({ app, authAdmin, mClientes, mResumen, prodPool, VV, grupos }) {

  async function obtener(q) {
    const f = leerFiltros(q);
    const p = [f.hasta + ' 23:59:59'];
    let w = `s.deleted_at IS NULL AND s.status IN ${VV} AND s.created_at <= ?`;
    if (f.empresa) { w += ' AND s.company_id = ?'; p.push(f.empresa); }
    const [ventas] = await prodPool.query(`
      SELECT s.customer_id, s.company_id, s.total, DATE_FORMAT(s.created_at, '%Y-%m-%d') AS dia
      FROM sales s WHERE ${w} AND s.customer_id IS NOT NULL`, p);
    const ids = [...new Set(ventas.map(v => v.customer_id))];
    let partes = [];
    if (ids.length) {
      [partes] = await prodPool.query(`
        SELECT id, is_company, business_name, first_name, last_name, document_number, email, phone
        FROM parties WHERE id IN (?)`, [ids]);
    }
    const unir = grupos && grupos.mapaAlias ? await grupos.mapaAlias() : null;
    return calcularClientes(ventas, partes, f, undefined, unir);
  }

  app.get('/api/clientes-bi', authAdmin, mClientes, async (req, res) => {
    try {
      const d = await obtener(req.query);
      d.opciones = {
        empresas: Object.entries(EMPRESAS_BI).map(([id, nombre]) => ({ id: +id, nombre })),
        umbrales: UMBRALES
      };
      res.json(d);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/clientes-bi-excel', authAdmin, mClientes, async (req, res) => {
    try {
      const d = await obtener(req.query);
      const f = d.filtros;
      const ExcelJS = require('exceljs');
      const wb = new ExcelJS.Workbook();
      const ESTADO_TXT = { nuevo: 'Nuevo', activo: 'Activo', en_riesgo: 'En riesgo', no_volvio: 'No volvió', perdido: 'Perdido' };
      const filtrosTxt = [
        ['Período', `${f.desde} a ${f.hasta}`],
        ['Empresa', f.empresa ? EMPRESAS_BI[f.empresa] : 'Todas'],
        ['Tipo', f.tipo === 'b2b' ? 'Empresas (B2B)' : f.tipo === 'b2c' ? 'Personas (B2C)' : 'Todos'],
        ['En riesgo desde', f.umbral + ' días'],
        ['Genéricos', f.genericos === 'incluir' ? 'Incluidos' : 'Excluidos']
      ];
      const cabecera = (ws) => {
        const h = ws.lastRow; h.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        h.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF000726' } };
      };

      // Hoja 1: Clientes
      const ws = wb.addWorksheet('Clientes');
      const cols = [
        ['Cliente', 34], ['RUC/DNI', 14], ['Tipo', 8], ['Estado', 11], ['Atrasado', 9],
        ['Ventas período', 10], ['Monto período', 14], ['% del período', 10], ['Monto período anterior', 14], ['Var. %', 9],
        ['Ventas hist.', 10], ['Monto hist.', 14], ['Ticket hist.', 12],
        ['Primera compra', 12], ['Última compra', 12], ['Días sin comprar', 10], ['Ritmo (días)', 10],
        ['Empresas', 28], ['Email', 26], ['Teléfono', 14]
      ];
      const filasCab = cabeceraExcel(ws, 'Clientes BI', filtrosTxt, cols.length);
      cols.forEach((c, i) => { ws.getColumn(i + 1).width = c[1]; });
      ws.addRow(cols.map(c => c[0])); cabecera(ws);
      d.clientes.forEach(c => ws.addRow([
        c.cliente, c.doc, c.tipo.toUpperCase(), ESTADO_TXT[c.estado], c.atrasado ? 'Sí' : '',
        c.per_ventas, c.per_monto, c.part != null ? c.part / 100 : null, c.ant_monto, c.var_monto != null ? c.var_monto / 100 : null,
        c.hist_ventas, c.hist_monto, c.hist_ticket,
        c.primera, c.ultima, c.dias_sin_comprar, c.ritmo_dias,
        c.empresas.join(', '), c.email, c.telefono
      ]));
      [7, 9, 12, 13].forEach(i => { ws.getColumn(i).numFmt = '#,##0.00'; });
      [8, 10].forEach(i => { ws.getColumn(i).numFmt = '0.0%'; });
      const hr = filasCab + 1;
      ws.views = [{ state: 'frozen', ySplit: hr }];
      ws.autoFilter = { from: { row: hr, column: 1 }, to: { row: hr, column: cols.length } };

      // Hoja 2: Mensual
      const wm = wb.addWorksheet('Mensual');
      cabeceraExcel(wm, 'Clientes por mes', filtrosTxt, 5);
      [10, 12, 10, 12, 14].forEach((w, i) => { wm.getColumn(i + 1).width = w; });
      wm.addRow(['Mes', 'Con compra', 'Nuevos', 'Volvieron', 'Monto']); cabecera(wm);
      d.mensual.forEach(m => wm.addRow([m.mes, m.activos, m.nuevos, m.recurrentes, m.monto]));
      wm.getColumn(5).numFmt = '#,##0.00';

      const nombre = nombreTrazable('clientes-bi');
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${nombre}.xlsx"`);
      await wb.xlsx.write(res);
      res.end();
    } catch (e) { res.status(500).json({ error: 'Error al generar el Excel: ' + e.message }); }
  });

  // B2B vs B2C (lo usa la pestaña "Ventas e ingresos"; permiso resumen)
  app.get('/api/tipo-cliente', authAdmin, mResumen, async (req, res) => {
    const { desde, hasta, empresa } = req.query;
    const emp = EMPRESAS_BI[parseInt(empresa, 10)] ? `AND s.company_id = ${parseInt(empresa, 10)}` : '';
    // Solo fechas válidas (rango() interpola el texto en el SQL)
    const f = (esFecha(desde) && esFecha(hasta) ? rango(desde, hasta) : '') + ' ' + emp;
    try {
      const [rows] = await prodPool.query(`
        SELECT p.is_company, COUNT(DISTINCT p.id) AS clientes, COUNT(s.id) AS ventas, COALESCE(SUM(s.total),0) AS total
        FROM sales s JOIN parties p ON p.id = s.customer_id
        WHERE s.deleted_at IS NULL AND s.status IN ${VV} ${f} GROUP BY p.is_company`);
      res.json(rows.map(r => ({ ...r, tipo: r.is_company ? 'Empresa (B2B)' : 'Persona (B2C)' })));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
};

module.exports._test = { calcularClientes, leerFiltros, esGenerico, mesesEntre };
