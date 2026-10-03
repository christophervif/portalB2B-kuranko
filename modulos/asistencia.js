// ═══════════════════════════════════════════════════════════════════════════
//  MÓDULO: Asistencia (control de llegada y salida del personal)
//
//  Cómo marca el trabajador:
//    Entra al panel con su usuario de siempre (ADMIN2, ADMIN3…) → botón
//    "Iniciar jornada" / "Terminar jornada". Una sola marca de entrada y una de
//    salida por día. La hora SIEMPRE es la del servidor (no la del celular).
//
//  Cómo se valida que esté en el local (sin rastreo, sin gastar batería):
//    1) IP: si se conecta desde el internet del local (PC o celular en el Wi-Fi)
//       → válida al instante, sin pedir GPS.
//    2) GPS: si no, se pide la ubicación SOLO en el momento de marcar y se
//       compara con el radio de la sede.
//    3) Equipo: cada trabajador puede tener hasta 2 equipos registrados (p. ej.
//       la PC del local y su celular). Uno nuevo → la marca queda "observada".
//    Si algo no cuadra, la marca NO se bloquea: se guarda como "observada" para
//    que el administrador la apruebe o rechace.
//
//  Celular de empresa (opcional, el trabajador no hace nada): una app de
//  automatización (Automate/Tasker) con geocerca llama a /api/asistencia/geo
//  al salir o volver al local. El reporte muestra "Fuera del local 11:20–12:40".
//
//  Horario por día (p. ej. lun–vie 09:00–18:00 y sábado 09:00–13:00) y SALDO
//  DE HORAS: si llega 30 min tarde y se queda 30 min más, queda compensado. Lo
//  que falte o sobre en la semana se cuadra normalmente el sábado (el reporte
//  sugiere a qué hora salir). El saldo se cuenta por mes.
//
//  Control cruzado (pasivo): lee del sistema principal (solo lectura) la primera
//  y la última acción de cada usuario en el día (ventas, movimientos de stock…)
//  para comparar "marcó a las 8:55" con "empezó a trabajar a las 9:30".
//
//  Datos en la base del PORTAL (tablas asist_*). El ERP solo se lee.
// ═══════════════════════════════════════════════════════════════════════════

const { nombreTrazable, cabeceraExcel } = require('./comunes');

// Lima no tiene horario de verano: UTC-5 fijo.
const OFFSET_LIMA_MS = 5 * 3600 * 1000;
const MAX_EQUIPOS = 2;
const MAX_DIAS_REPORTE = 93;
const MIN_FUERA = 5;          // salidas más cortas se ignoran (rebote del GPS en el borde)

// ── Fechas / horas ─────────────────────────────────────────────────────────
const p2 = n => String(n).padStart(2, '0');
const fechaLimaDe = d => new Date(d.getTime() - OFFSET_LIMA_MS).toISOString().slice(0, 10);
const horaLimaDe = d => new Date(d.getTime() - OFFSET_LIMA_MS).toISOString().slice(11, 16);
const utcSql = d => d.toISOString().slice(0, 19).replace('T', ' ');
const deUtcSql = s => s ? new Date(String(s).replace(' ', 'T') + 'Z') : null;
const sumarDias = (f, n) => { const d = new Date(f + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const diaSemana = f => { const w = new Date(f + 'T00:00:00Z').getUTCDay(); return w === 0 ? 7 : w; }; // 1=lun … 7=dom
const fechaValida = f => /^\d{4}-\d{2}-\d{2}$/.test(f || '') && !isNaN(new Date(f + 'T00:00:00Z'));
const horaValida = h => /^([01]\d|2[0-3]):[0-5]\d$/.test(h || '');
const aMin = h => { const [a, b] = h.split(':').map(Number); return a * 60 + b; };
// Minutos del día (hora Lima) de un instante
const minDelDia = d => { const x = new Date(d.getTime() - OFFSET_LIMA_MS); return x.getUTCHours() * 60 + x.getUTCMinutes(); };

// Distancia en metros entre dos coordenadas (fórmula de haversine)
function distanciaM(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = x => x * Math.PI / 180;
  const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

// IP real del cliente. Railway agrega la IP de quien se conecta al FINAL de
// X-Forwarded-For; tomamos la última para que nadie la falsifique enviando la
// cabecera a mano. (El botón "Usar mi IP actual" muestra lo que ve el servidor.)
function ipCliente(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
  let ip = xff.length ? xff[xff.length - 1] : (req.socket && req.socket.remoteAddress) || '';
  return ip.replace(/^::ffff:/, '');
}

const listaIps = s => String(s || '').split(/[\s,;]+/).map(x => x.trim()).filter(Boolean);
const listaDias = s => String(s || '').split(',').map(Number).filter(n => n >= 1 && n <= 7);
const recortar = (s, n) => String(s == null ? '' : s).trim().slice(0, n);

module.exports = function registrarAsistencia({
  app, authAdmin, requiereModulo, prodPool, portalPool, leerAdminsSecundarios
}) {
  const mAsis = requiereModulo('asistencia');
  const quien = req => (req.admin && req.admin.usuario) || 'admin';
  const puedeControlar = a => !!(a && (a.maestro || (Array.isArray(a.modulos) && a.modulos.includes('asistencia'))));

  // ── Tablas (una sola vez por arranque) ───────────────────────────────────
  let _tablas = null;
  function asegurarTablas() {
    if (!_tablas) _tablas = crearTablas().catch(e => { _tablas = null; throw e; });
    return _tablas;
  }
  async function crearTablas() {
    await portalPool.query(`
      CREATE TABLE IF NOT EXISTS asist_config (
        id TINYINT PRIMARY KEY,
        hora_entrada CHAR(5) NOT NULL DEFAULT '09:00',
        hora_salida CHAR(5) NOT NULL DEFAULT '18:00',
        dias VARCHAR(20) NOT NULL DEFAULT '1,2,3,4,5,6',
        tolerancia_min INT NOT NULL DEFAULT 10,
        precision_max_m INT NOT NULL DEFAULT 150,
        min_jornada_min INT NOT NULL DEFAULT 30,
        prod_tz VARCHAR(6) NOT NULL DEFAULT '+00:00'
      )`);
    await portalPool.query(`INSERT IGNORE INTO asist_config (id) VALUES (1)`);
    await portalPool.query(`
      CREATE TABLE IF NOT EXISTS asist_sedes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        nombre VARCHAR(100) NOT NULL,
        lat DECIMAL(10,7) NULL,
        lng DECIMAL(10,7) NULL,
        radio_m INT NOT NULL DEFAULT 100,
        ips VARCHAR(500) NOT NULL DEFAULT '',
        activo TINYINT NOT NULL DEFAULT 1
      )`);
    await portalPool.query(`
      CREATE TABLE IF NOT EXISTS asist_personal (
        usuario VARCHAR(80) PRIMARY KEY,
        nombre VARCHAR(120) NULL,
        controlar TINYINT NOT NULL DEFAULT 1,
        hora_entrada CHAR(5) NULL,
        hora_salida CHAR(5) NULL,
        dias VARCHAR(20) NULL,
        prod_user_id BIGINT NULL,
        equipos TEXT NULL,
        creado DATE NULL,
        geo_token VARCHAR(48) NULL,
        UNIQUE KEY uq_geo (geo_token)
      )`);
    // Horario por día (JSON {"1":["09:00","18:00"],…,"6":["09:00","13:00"]})
    for (const t of ['asist_config', 'asist_personal'])
      try { await portalPool.query(`ALTER TABLE ${t} ADD COLUMN horario_json TEXT NULL`); } catch (e) { /* ya existe */ }
    // Para quien ya tenía la tabla creada (versión anterior del módulo)
    try { await portalPool.query(`ALTER TABLE asist_personal ADD COLUMN geo_token VARCHAR(48) NULL, ADD UNIQUE KEY uq_geo (geo_token)`); } catch (e) { /* ya existe */ }
    await portalPool.query(`
      CREATE TABLE IF NOT EXISTS asist_geo (
        id INT AUTO_INCREMENT PRIMARY KEY,
        usuario VARCHAR(80) NOT NULL,
        ts DATETIME NOT NULL,
        evento VARCHAR(8) NOT NULL,
        ip VARCHAR(64) NULL,
        KEY ix_usu_ts (usuario, ts)
      )`);
    await portalPool.query(`
      CREATE TABLE IF NOT EXISTS asist_marcas (
        id INT AUTO_INCREMENT PRIMARY KEY,
        usuario VARCHAR(80) NOT NULL,
        fecha DATE NOT NULL,
        tipo VARCHAR(8) NOT NULL,
        ts DATETIME NOT NULL,
        metodo VARCHAR(10) NOT NULL,
        sede_id INT NULL,
        lat DECIMAL(10,7) NULL,
        lng DECIMAL(10,7) NULL,
        precision_m INT NULL,
        distancia_m INT NULL,
        ip VARCHAR(64) NULL,
        equipo VARCHAR(64) NULL,
        agente VARCHAR(200) NULL,
        estado VARCHAR(12) NOT NULL DEFAULT 'ok',
        motivos VARCHAR(400) NULL,
        nota_trabajador VARCHAR(300) NULL,
        revisado_por VARCHAR(80) NULL,
        revisado_ts DATETIME NULL,
        nota_revision VARCHAR(300) NULL,
        creado_por VARCHAR(80) NULL,
        UNIQUE KEY uq_dia (usuario, fecha, tipo),
        KEY ix_fecha (fecha),
        KEY ix_estado (estado)
      )`);
  }

  async function leerConfig() {
    const [[c]] = await portalPool.query(`SELECT * FROM asist_config WHERE id=1`);
    return c;
  }
  async function leerSedes(soloActivas = true) {
    const [r] = await portalPool.query(`SELECT * FROM asist_sedes ${soloActivas ? 'WHERE activo=1' : ''} ORDER BY nombre`);
    return r.map(s => ({ ...s, lat: s.lat == null ? null : Number(s.lat), lng: s.lng == null ? null : Number(s.lng), ips: listaIps(s.ips) }));
  }
  const parsearEquipos = t => { try { const a = JSON.parse(t || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } };

  // Ficha del trabajador (se crea sola la primera vez que la necesita)
  // (el maestro se crea SIN control: es el dueño, no aparece como falta)
  async function fichaDe(usuario, controlar = 1) {
    await portalPool.query(`INSERT IGNORE INTO asist_personal (usuario, nombre, controlar, creado) VALUES (?, ?, ?, ?)`, [usuario, usuario, controlar ? 1 : 0, fechaLimaDe(new Date())]);
    const [[p]] = await portalPool.query(`SELECT * FROM asist_personal WHERE usuario=?`, [usuario]);
    return p;
  }
  // Agrega a la lista a todos los usuarios secundarios definidos en Railway
  async function sincronizarPersonal() {
    const sec = (leerAdminsSecundarios ? leerAdminsSecundarios() : []).map(a => a.usuario);
    for (const u of sec) await portalPool.query(`INSERT IGNORE INTO asist_personal (usuario, nombre, creado) VALUES (?, ?, ?)`, [u, u, fechaLimaDe(new Date())]);
    return new Set(sec);
  }
  // Horario por día de la semana: { 1: {entrada, salida}, …, 6: {…} } (día ausente = no laborable)
  function parsearHorario(txt) {
    let o; try { o = JSON.parse(txt || 'null'); } catch (e) { return null; }
    if (!o || typeof o !== 'object') return null;
    const h = {};
    for (let d = 1; d <= 7; d++) {
      const v = o[d];
      if (Array.isArray(v) && horaValida(v[0]) && horaValida(v[1]) && aMin(v[1]) > aMin(v[0])) h[d] = { entrada: v[0], salida: v[1] };
    }
    return Object.keys(h).length ? h : null;
  }
  const horarioSimple = (ent, sal, dias) => { const h = {}; listaDias(dias).forEach(d => { h[d] = { entrada: ent, salida: sal }; }); return h; };
  const horarioGeneral = c => parsearHorario(c.horario_json) || horarioSimple(c.hora_entrada, c.hora_salida, c.dias);
  // Propio si lo tiene; si no, el general (compatible con la versión anterior: entrada/salida/días sueltos)
  function horarioPropio(p, c) {
    const j = parsearHorario(p.horario_json);
    if (j) return j;
    if (p.hora_entrada || p.hora_salida || p.dias) {
      const g = horarioGeneral(c), g1 = g[1] || Object.values(g)[0] || { entrada: c.hora_entrada, salida: c.hora_salida };
      return horarioSimple(p.hora_entrada || g1.entrada, p.hora_salida || g1.salida, p.dias || Object.keys(g).join(','));
    }
    return null;
  }
  const horarioDe = (p, c) => horarioPropio(p, c) || horarioGeneral(c);
  const aJson = h => JSON.stringify(Object.fromEntries(Object.entries(h).map(([d, v]) => [d, [v.entrada, v.salida]])));
  // Valida lo que manda la pantalla: { "1": ["09:00","18:00"], … }
  function horarioDeBody(o) {
    if (!o || typeof o !== 'object') return null;
    const h = {};
    for (const [d, v] of Object.entries(o)) {
      const n = Number(d);
      if (!(n >= 1 && n <= 7) || !Array.isArray(v)) continue;
      if (!horaValida(v[0]) || !horaValida(v[1])) throw new Error('Hora inválida (usa HH:MM)');
      if (aMin(v[1]) <= aMin(v[0])) throw new Error('La salida debe ser después de la entrada');
      h[n] = { entrada: v[0], salida: v[1] };
    }
    return Object.keys(h).length ? h : null;
  }
  const minEsperados = hd => hd ? aMin(hd.salida) - aMin(hd.entrada) : 0;
  const lunesDe = f => sumarDias(f, 1 - diaSemana(f));

  // Saldo de horas de la semana y del mes en curso (+ sugerencia para el sábado)
  async function saldosActuales(usuario = null) {
    const hoy = fechaLimaDe(new Date());
    const lunes = lunesDe(hoy), mes1 = hoy.slice(0, 8) + '01';
    const r = await construirResumen(lunes < mes1 ? lunes : mes1, hoy, { usuario, conActividad: false });
    const out = {};
    r.totales.forEach(t => { out[t.usuario] = { usuario: t.usuario, nombre: t.nombre, semana: 0, mes: 0, dias_semana: 0 }; });
    r.filas.forEach(f => {
      if (f.saldo == null) return;
      const o = out[f.usuario]; if (!o) return;
      if (f.fecha >= lunes) { o.semana += f.saldo; o.dias_semana++; if (f.dia !== 6) o.semana_lv = (o.semana_lv || 0) + f.saldo; }
      if (f.fecha >= mes1) o.mes += f.saldo;
    });
    // Sábado de esta semana: a qué hora debería salir para cuadrar la semana
    const sab = sumarDias(lunes, 5);
    for (const t of r.totales) {
      const o = out[t.usuario], hs = r.horarios[t.usuario] || {};
      const hd = hs[6];
      if (hd && sab >= hoy) {
        const sug = aMin(hd.salida) - (o.semana_lv || 0); // debe (saldo negativo) → sale más tarde
        const fmt = m => p2(Math.floor(((m % 1440) + 1440) % 1440 / 60)) + ':' + p2(((m % 60) + 60) % 60);
        o.sabado = { fecha: sab, entrada: hd.entrada, salida_base: hd.salida, salida_sugerida: fmt(Math.max(aMin(hd.entrada), sug)) };
      }
    }
    return Object.values(out);
  }

  async function marcasDelDia(usuario, fecha) {
    const [r] = await portalPool.query(
      `SELECT id, tipo, DATE_FORMAT(ts,'%Y-%m-%d %H:%i:%s') AS ts, metodo, estado, motivos, nota_trabajador
       FROM asist_marcas WHERE usuario=? AND fecha=?`, [usuario, fecha]);
    const out = {};
    r.forEach(m => { out[m.tipo] = { id: m.id, hora: horaLimaDe(deUtcSql(m.ts)), metodo: m.metodo, estado: m.estado, motivos: m.motivos || '', nota: m.nota_trabajador || '' }; });
    return out;
  }

  // ═════════════════════════════════════════════════════════════════════════
  //  TRABAJADOR
  // ═════════════════════════════════════════════════════════════════════════

  // Estado de hoy: qué le toca marcar y si ya está en la red del local
  app.get('/api/asistencia/mi-estado', authAdmin, async (req, res) => {
    try {
      await asegurarTablas();
      const usuario = quien(req);
      const ahora = new Date();
      const hoy = fechaLimaDe(ahora);
      const esMaestro = !!(req.admin && req.admin.maestro);
      const [p, c, sedes, marcas] = await Promise.all([fichaDe(usuario, !esMaestro), leerConfig(), leerSedes(), marcasDelDia(usuario, hoy)]);
      const ip = ipCliente(req);
      const sedeIp = sedes.find(s => s.ips.includes(ip));
      let siguiente = null;
      if (p.controlar) siguiente = !marcas.entrada ? 'entrada' : (!marcas.salida ? 'salida' : null);
      res.json({
        usuario, nombre: p.nombre || usuario, controlar: !!p.controlar,
        maestro: !!(req.admin && req.admin.maestro), puede_controlar: puedeControlar(req.admin),
        hoy, servidor_ts: ahora.getTime(),
        entrada: marcas.entrada || null, salida: marcas.salida || null, siguiente,
        horario: horarioDe(p, c)[diaSemana(hoy)] || null, laborable: !!horarioDe(p, c)[diaSemana(hoy)],
        saldo: p.controlar ? ((await saldosActuales(usuario))[0] || null) : null,
        ip, ip_local: !!sedeIp, sede_ip: sedeIp ? sedeIp.nombre : null,
        hay_sedes: sedes.length > 0
      });
    } catch (e) { res.status(500).json({ error: 'Error al leer tu estado: ' + e.message }); }
  });

  // Marcar entrada o salida (el servidor decide cuál toca)
  app.post('/api/asistencia/marcar', authAdmin, async (req, res) => {
    try {
      await asegurarTablas();
      const usuario = quien(req);
      const ahora = new Date();
      const hoy = fechaLimaDe(ahora);
      const [p, c, sedes, marcas] = await Promise.all([fichaDe(usuario, !(req.admin && req.admin.maestro)), leerConfig(), leerSedes(), marcasDelDia(usuario, hoy)]);
      if (!p.controlar) return res.status(400).json({ error: 'Tu usuario no tiene control de asistencia.' });

      let tipo;
      if (!marcas.entrada) tipo = 'entrada';
      else if (!marcas.salida) {
        tipo = 'salida';
        const desde = new Date(hoy + 'T' + marcas.entrada.hora + ':00Z').getTime() + OFFSET_LIMA_MS;
        const mins = (ahora.getTime() - desde) / 60000;
        if (mins < c.min_jornada_min)
          return res.status(400).json({ error: `Marcaste tu entrada hace ${Math.max(0, Math.floor(mins))} min. La salida se habilita después de ${c.min_jornada_min} min.` });
      } else return res.status(400).json({ error: 'Ya registraste tu entrada y tu salida de hoy.' });

      const b = req.body || {};
      const motivos = [];
      const ip = ipCliente(req);
      let metodo = 'ninguno', sedeId = null, lat = null, lng = null, prec = null, dist = null;

      // 1) Red del local
      const sedeIp = sedes.find(s => s.ips.includes(ip));
      if (sedeIp) { metodo = 'ip'; sedeId = sedeIp.id; }

      // 2) GPS (se guarda siempre que venga, aunque la IP ya valide)
      const g = b.gps;
      if (g && isFinite(g.lat) && isFinite(g.lng) && Math.abs(g.lat) <= 90 && Math.abs(g.lng) <= 180) {
        lat = Number(g.lat); lng = Number(g.lng); prec = isFinite(g.precision) ? Math.round(g.precision) : null;
        const conCoord = sedes.filter(s => s.lat != null && s.lng != null);
        let cerca = null;
        conCoord.forEach(s => { const d = distanciaM(lat, lng, s.lat, s.lng); if (!cerca || d < cerca.d) cerca = { s, d }; });
        if (cerca) dist = cerca.d;
        if (!sedeIp) {
          metodo = 'gps';
          if (cerca) {
            sedeId = cerca.s.id;
            if (prec != null && prec > c.precision_max_m) motivos.push(`GPS impreciso (±${prec} m)`);
            if (cerca.d > cerca.s.radio_m) motivos.push(`Fuera del local: a ${cerca.d} m de ${cerca.s.nombre}`);
          }
        }
      } else if (!sedeIp && sedes.length) {
        motivos.push(b.gps_error ? 'Sin ubicación: ' + recortar(b.gps_error, 80) : 'Sin ubicación');
      }

      // 3) Equipo registrado
      const equipo = /^[A-Za-z0-9-]{8,64}$/.test(b.equipo || '') ? b.equipo : null;
      const equipos = parsearEquipos(p.equipos);
      if (!equipo) motivos.push('Equipo sin identificar');
      else if (!equipos.some(e => e.id === equipo)) {
        if (equipos.length < MAX_EQUIPOS) {
          equipos.push({ id: equipo, etiqueta: recortar(b.equipo_nombre, 60) || 'Equipo ' + (equipos.length + 1), desde: hoy });
          await portalPool.query(`UPDATE asist_personal SET equipos=? WHERE usuario=?`, [JSON.stringify(equipos), usuario]);
        } else motivos.push('Equipo no registrado');
      }

      const estado = motivos.length ? 'observada' : 'ok';
      try {
        const [r] = await portalPool.query(
          `INSERT INTO asist_marcas (usuario, fecha, tipo, ts, metodo, sede_id, lat, lng, precision_m, distancia_m, ip, equipo, agente, estado, motivos, creado_por)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [usuario, hoy, tipo, utcSql(ahora), metodo, sedeId, lat, lng, prec, dist, ip, equipo,
            recortar(req.headers['user-agent'], 200), estado, motivos.join(' · ') || null, usuario]);
        res.json({ ok: true, id: r.insertId, tipo, hora: horaLimaDe(ahora), estado, motivos, metodo });
      } catch (e) {
        if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Esa marca ya estaba registrada.' });
        throw e;
      }
    } catch (e) { res.status(500).json({ error: 'No se pudo registrar la marca: ' + e.message }); }
  });

  // El trabajador explica una marca observada de hoy
  app.post('/api/asistencia/nota', authAdmin, async (req, res) => {
    try {
      await asegurarTablas();
      const { id, nota } = req.body || {};
      const [r] = await portalPool.query(
        `UPDATE asist_marcas SET nota_trabajador=? WHERE id=? AND usuario=? AND fecha=?`,
        [recortar(nota, 300) || null, Number(id) || 0, quien(req), fechaLimaDe(new Date())]);
      if (!r.affectedRows) return res.status(404).json({ error: 'Marca no encontrada' });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Geocerca del celular de empresa ──
  // La app del celular llama a esta URL al salir / volver al local:
  //   /api/asistencia/geo?k=CLAVE&e=salida   |   &e=entrada   |   &e=latido
  // La clave identifica al trabajador (se genera en Personal). Sin login.
  app.all('/api/asistencia/geo', async (req, res) => {
    try {
      await asegurarTablas();
      const q = { ...(req.query || {}), ...(typeof req.body === 'object' ? req.body : {}) };
      // Tolerante a espacios, mayúsculas o signos pegados al copiar el link
      const k = String(q.k || '').toLowerCase().replace(/[^a-f0-9]/g, '');
      const eTxt = String(q.e || q['amp;e'] || '').toLowerCase().replace(/[^a-z]/g, '');
      const e = { salida: 'salida', sale: 'salida', out: 'salida', exit: 'salida',
        entrada: 'entrada', vuelve: 'entrada', in: 'entrada', enter: 'entrada', latido: 'latido', ping: 'latido' }[eTxt];
      if (!k) return res.status(400).send('Falta la clave (k=...) en el link');
      if (k.length < 32) return res.status(400).send(`Clave incompleta: tiene ${k.length} caracteres y debe tener 40. Copia el link completo.`);
      if (!e) return res.status(400).send('El link debe terminar en &e=salida o &e=entrada');
      const [[p]] = await portalPool.query(`SELECT usuario FROM asist_personal WHERE geo_token=?`, [k]);
      if (!p) return res.status(403).send('Clave no válida');
      // Evita duplicados si la app reintenta (mismo evento en los últimos 2 min)
      const [[dup]] = await portalPool.query(
        `SELECT id FROM asist_geo WHERE usuario=? AND evento=? AND ts > UTC_TIMESTAMP() - INTERVAL 2 MINUTE LIMIT 1`, [p.usuario, e]);
      if (!dup) await portalPool.query(`INSERT INTO asist_geo (usuario, ts, evento, ip) VALUES (?, UTC_TIMESTAMP(), ?, ?)`, [p.usuario, e, ipCliente(req)]);
      res.send('ok');
    } catch (err) { res.status(500).send('error'); }
  });

  // Historial propio del mes (el trabajador debe poder ver sus marcas)
  app.get('/api/asistencia/mis-marcas', authAdmin, async (req, res) => {
    try {
      await asegurarTablas();
      const mes = /^\d{4}-\d{2}$/.test(req.query.mes || '') ? req.query.mes : fechaLimaDe(new Date()).slice(0, 7);
      const desde = mes + '-01';
      let hasta = sumarDias(sumarDias(desde, 32).slice(0, 7) + '-01', -1);
      const hoy = fechaLimaDe(new Date());
      if (hasta > hoy) hasta = hoy;
      if (hasta < desde) return res.json({ mes, filas: [], totales: {} });
      const r = await construirResumen(desde, hasta, { usuario: quien(req), conActividad: false });
      res.json({ mes, filas: r.filas, totales: r.totales[0] || {} });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ═════════════════════════════════════════════════════════════════════════
  //  ACTIVIDAD EN EL SISTEMA PRINCIPAL (solo lectura)
  // ═════════════════════════════════════════════════════════════════════════
  // Busca qué tablas del ERP guardan "quién" y "cuándo" (se detecta una vez).
  const CANDIDATAS = ['sales', 'stock_movements', 'stock_entries', 'stock_transfers', 'sale_payments', 'payments', 'cash_closures', 'quotations'];
  let _fuentes = null;
  async function fuentesActividad() {
    if (_fuentes) return _fuentes;
    const [cols] = await prodPool.query(
      `SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?) AND COLUMN_NAME IN ('created_by','user_id','seller_id','created_at','movement_date')`,
      [CANDIDATAS]);
    const porTabla = {};
    cols.forEach(x => { (porTabla[x.t] = porTabla[x.t] || new Set()).add(x.c); });
    const out = [];
    for (const t of CANDIDATAS) {
      const s = porTabla[t]; if (!s) continue;
      const u = ['created_by', 'user_id', 'seller_id'].find(c => s.has(c));
      const tc = s.has('created_at') ? 'created_at' : (t === 'stock_movements' && s.has('movement_date') ? 'movement_date' : null);
      if (u && tc) out.push({ tabla: t, u, tc });
    }
    _fuentes = out;
    return out;
  }

  // { 'prodId|fecha': { primera:'HH:MM', ultima:'HH:MM', acciones:n } }
  async function actividad(desde, hasta, prodIds, tz) {
    const res = {};
    if (!prodIds.length) return res;
    const off = /^[+-]\d{2}:\d{2}$/.test(tz || '') ? tz : '+00:00';
    // Rango del día Lima expresado en la zona en que guarda el ERP
    const offMin = (off[0] === '-' ? -1 : 1) * (Number(off.slice(1, 3)) * 60 + Number(off.slice(4, 6)));
    const ini = new Date(Date.parse(desde + 'T00:00:00Z') + OFFSET_LIMA_MS + offMin * 60000);
    const fin = new Date(Date.parse(sumarDias(hasta, 1) + 'T00:00:00Z') + OFFSET_LIMA_MS + offMin * 60000);
    const fuentes = await fuentesActividad();
    await Promise.all(fuentes.map(async f => {
      try {
        const [r] = await prodPool.query(
          `SELECT \`${f.u}\` AS uid,
             DATE_FORMAT(CONVERT_TZ(MIN(\`${f.tc}\`), ?, '-05:00'), '%Y-%m-%d %H:%i') AS mi,
             DATE_FORMAT(CONVERT_TZ(MAX(\`${f.tc}\`), ?, '-05:00'), '%Y-%m-%d %H:%i') AS ma,
             COUNT(*) AS n
           FROM \`${f.tabla}\`
           WHERE \`${f.tc}\` >= ? AND \`${f.tc}\` < ? AND \`${f.u}\` IN (?)
           GROUP BY \`${f.u}\`, DATE(CONVERT_TZ(\`${f.tc}\`, ?, '-05:00'))`,
          [off, off, utcSql(ini), utcSql(fin), prodIds, off]);
        r.forEach(x => {
          if (!x.mi) return;
          const k = x.uid + '|' + x.mi.slice(0, 10);
          const a = res[k] || (res[k] = { primera: null, ultima: null, acciones: 0 });
          const hmi = x.mi.slice(11), hma = x.ma.slice(11);
          if (!a.primera || hmi < a.primera) a.primera = hmi;
          if (!a.ultima || hma > a.ultima) a.ultima = hma;
          a.acciones += Number(x.n) || 0;
        });
      } catch (e) { console.warn('[asistencia] actividad', f.tabla, e.message); }
    }));
    return res;
  }

  // ═════════════════════════════════════════════════════════════════════════
  //  RESUMEN (lo usan el reporte, el Excel y "mis marcas")
  // ═════════════════════════════════════════════════════════════════════════
  // Intervalos fuera del local dentro de [desdeT, hastaT] según los eventos
  // empiezaDentro: la marca de entrada ya prueba que estaba en el local (así un
  // aviso de "volví" perdido en la mañana no deja todo el día como "fuera").
  function salidasEn(eventos, desdeT, hastaT, empiezaDentro = false) {
    if (!(hastaT > desdeT)) return [];
    let fuera = false, ini = null;
    const out = [];
    for (const ev of eventos) {
      const t = ev.t.getTime();
      if (t <= desdeT) { if (!empiezaDentro) fuera = ev.e === 'salida'; continue; }
      if (t >= hastaT) break;
      if (ev.e === 'salida' && !fuera) { fuera = true; ini = t; }
      else if (ev.e === 'entrada' && fuera) { out.push({ a: ini == null ? desdeT : ini, b: t }); fuera = false; ini = null; }
    }
    if (fuera) out.push({ a: ini == null ? desdeT : ini, b: hastaT, abierta: true });
    return out.filter(x => (x.b - x.a) >= MIN_FUERA * 60000);
  }

  async function construirResumen(desde, hasta, { usuario = null, conActividad = true } = {}) {
    const c = await leerConfig();
    const [pers] = await portalPool.query(
      `SELECT *, DATE_FORMAT(creado,'%Y-%m-%d') AS creado_f FROM asist_personal ${usuario ? 'WHERE usuario=?' : 'WHERE controlar=1'} ORDER BY nombre, usuario`,
      usuario ? [usuario] : []);
    const [mar] = await portalPool.query(
      `SELECT id, usuario, DATE_FORMAT(fecha,'%Y-%m-%d') AS fecha, tipo, DATE_FORMAT(ts,'%Y-%m-%d %H:%i:%s') AS ts,
         metodo, estado, motivos, nota_trabajador, nota_revision, revisado_por
       FROM asist_marcas WHERE fecha BETWEEN ? AND ? ${usuario ? 'AND usuario=?' : ''}`,
      usuario ? [desde, hasta, usuario] : [desde, hasta]);
    const idx = {};
    mar.forEach(m => { idx[m.usuario + '|' + m.fecha + '|' + m.tipo] = m; });

    // Eventos de geocerca (desde un día antes, para saber si ya estaba fuera)
    const geo = {};
    const conGeo = pers.filter(p => p.geo_token).map(p => p.usuario);
    if (conGeo.length) {
      const [g] = await portalPool.query(
        `SELECT usuario, evento, DATE_FORMAT(ts,'%Y-%m-%d %H:%i:%s') AS ts FROM asist_geo
         WHERE usuario IN (?) AND evento IN ('salida','entrada') AND ts >= ? AND ts < ? ORDER BY ts`,
        [conGeo, utcSql(new Date(Date.parse(sumarDias(desde, -1) + 'T00:00:00Z') + OFFSET_LIMA_MS)),
          utcSql(new Date(Date.parse(sumarDias(hasta, 1) + 'T00:00:00Z') + OFFSET_LIMA_MS))]);
      g.forEach(x => (geo[x.usuario] = geo[x.usuario] || []).push({ e: x.evento, t: deUtcSql(x.ts) }));
    }

    const prodIds = [...new Set(pers.map(p => p.prod_user_id).filter(Boolean))];
    const act = conActividad ? await actividad(desde, hasta, prodIds, c.prod_tz) : {};

    const ahora = new Date();
    const hoy = fechaLimaDe(ahora), minAhora = minDelDia(ahora);
    const filas = [], totales = [], horarios = {};
    for (const p of pers) {
      const h = horarioDe(p, c);
      horarios[p.usuario] = h;
      const t = { usuario: p.usuario, nombre: p.nombre || p.usuario, dias_lab: 0, asistidos: 0, faltas: 0, tardanzas: 0, min_tardanza: 0, min_trabajados: 0, sin_salida: 0, observadas: 0, salidas: 0, min_fuera: 0, saldo: 0, compensadas: 0 };
      for (let f = desde; f <= hasta && f <= hoy; f = sumarDias(f, 1)) {
        const hd = h[diaSemana(f)] || null;
        const lab = !!hd;
        const en = idx[p.usuario + '|' + f + '|entrada'], sa = idx[p.usuario + '|' + f + '|salida'];
        if (!en && !sa && (!lab || (p.creado_f && f < p.creado_f))) continue; // sin faltas antes de entrar al control
        const valida = m => m && m.estado !== 'rechazada' ? m : null;
        const e = valida(en), s = valida(sa);
        const de = e ? deUtcSql(e.ts) : null, ds = s ? deUtcSql(s.ts) : null;
        const fila = {
          fecha: f, dia: diaSemana(f), usuario: p.usuario, nombre: p.nombre || p.usuario, laborable: lab,
          horario: hd ? hd.entrada + '–' + hd.salida : '—',
          entrada: de ? horaLimaDe(de) : null, salida: ds ? horaLimaDe(ds) : null,
          entrada_estado: en ? en.estado : null, salida_estado: sa ? sa.estado : null,
          entrada_id: en ? en.id : null, salida_id: sa ? sa.id : null,
          motivos: [en && en.motivos, sa && sa.motivos].filter(Boolean).join(' · '),
          notas: [en && en.nota_trabajador, sa && sa.nota_trabajador].filter(Boolean).join(' · '),
          min_trabajados: de && ds ? Math.max(0, Math.round((ds - de) / 60000)) : null,
          min_tardanza: 0, min_salida_antes: 0, estado: ''
        };
        if (de && lab) {
          const tarde = minDelDia(de) - aMin(hd.entrada);
          if (tarde > c.tolerancia_min) fila.min_tardanza = tarde;
        }
        if (ds && lab) { const antes = aMin(hd.salida) - minDelDia(ds); if (antes > 0) fila.min_salida_antes = antes; }
        // Saldo del día: trabajado − esperado (en día no laborable, todo es a favor)
        if (fila.min_trabajados != null) {
          fila.saldo = fila.min_trabajados - minEsperados(hd);
          if (fila.min_tardanza && fila.saldo >= 0) fila.tardanza_compensada = true;
        }
        if (e && s) fila.estado = 'completo';
        else if (e && !s) fila.estado = f === hoy ? 'en_curso' : 'sin_salida';
        else if (!e && lab) fila.estado = (f === hoy && minAhora < aMin(hd.salida)) ? 'pendiente' : 'falta';
        else fila.estado = 'sin_entrada';
        if ([en, sa].some(m => m && m.estado === 'observada')) fila.observada = true;
        // Salidas del local durante la jornada (solo celulares con geocerca)
        if (geo[p.usuario]) {
          const iniDia = Date.parse(f + 'T00:00:00Z') + OFFSET_LIMA_MS;
          const desdeT = de ? de.getTime() : iniDia + aMin(hd ? hd.entrada : '00:00') * 60000;
          let hastaT = ds ? ds.getTime() : (f === hoy ? ahora.getTime() : (hd ? iniDia + aMin(hd.salida) * 60000 : desdeT + 12 * 3600000));
          if (f === hoy) hastaT = Math.min(hastaT, ahora.getTime());
          const ints = salidasEn(geo[p.usuario], desdeT, hastaT, !!(e && ['ok', 'aprobada', 'manual'].includes(e.estado)));
          if (ints.length) {
            fila.fuera = ints.map(x => ({ desde: horaLimaDe(new Date(x.a)), hasta: x.abierta ? null : horaLimaDe(new Date(x.b)), min: Math.round((x.b - x.a) / 60000) }));
            fila.min_fuera = fila.fuera.reduce((s, x) => s + x.min, 0);
            t.salidas += ints.length; t.min_fuera += fila.min_fuera;
          }
        }
        if (p.prod_user_id) {
          const a = act[p.prod_user_id + '|' + f];
          if (a) {
            fila.act_primera = a.primera; fila.act_ultima = a.ultima; fila.act_acciones = a.acciones;
            if (fila.entrada) fila.min_hasta_actividad = aMin(a.primera) - aMin(fila.entrada);
            if (fila.salida) fila.min_despues_actividad = aMin(fila.salida) - aMin(a.ultima);
          }
        }
        filas.push(fila);
        if (lab) t.dias_lab++;
        if (e) t.asistidos++;
        if (fila.estado === 'falta') t.faltas++;
        if (fila.estado === 'sin_salida') t.sin_salida++;
        if (fila.min_tardanza && fila.tardanza_compensada) t.compensadas++;
        else if (fila.min_tardanza) { t.tardanzas++; t.min_tardanza += fila.min_tardanza; }
        if (fila.saldo != null) t.saldo += fila.saldo;
        if (fila.min_trabajados) t.min_trabajados += fila.min_trabajados;
        if (fila.observada) t.observadas++;
      }
      totales.push(t);
    }
    filas.sort((a, b) => (a.fecha < b.fecha ? 1 : a.fecha > b.fecha ? -1 : 0) || a.nombre.localeCompare(b.nombre));
    return { filas, totales, horarios, config: c };
  }

  function rangoDe(q) {
    const hoy = fechaLimaDe(new Date());
    let desde = fechaValida(q.desde) ? q.desde : sumarDias(hoy, -6);
    let hasta = fechaValida(q.hasta) ? q.hasta : hoy;
    if (hasta < desde) [desde, hasta] = [hasta, desde];
    if (sumarDias(desde, MAX_DIAS_REPORTE) < hasta) desde = sumarDias(hasta, -MAX_DIAS_REPORTE);
    return { desde, hasta };
  }

  // ═════════════════════════════════════════════════════════════════════════
  //  ADMINISTRACIÓN (módulo 'asistencia'; el maestro siempre entra)
  // ═════════════════════════════════════════════════════════════════════════

  app.get('/api/asistencia/admin/reporte', authAdmin, mAsis, async (req, res) => {
    try {
      await asegurarTablas();
      await sincronizarPersonal();
      const { desde, hasta } = rangoDe(req.query);
      const usuario = recortar(req.query.usuario, 80) || null;
      const r = await construirResumen(desde, hasta, { usuario });
      const [[obs]] = await portalPool.query(`SELECT COUNT(*) AS n FROM asist_marcas WHERE estado='observada'`);
      const sedes = await leerSedes();
      const saldos = await saldosActuales(usuario);
      res.json({ desde, hasta, filas: r.filas, totales: r.totales, saldos, observadas_pendientes: obs.n, hay_sedes: sedes.length > 0 });
    } catch (e) { res.status(500).json({ error: 'Error al armar el reporte: ' + e.message }); }
  });

  // Marcas por revisar (observadas) o historial de revisadas
  app.get('/api/asistencia/admin/marcas', authAdmin, mAsis, async (req, res) => {
    try {
      await asegurarTablas();
      const estado = ['observada', 'aprobada', 'rechazada', 'manual'].includes(req.query.estado) ? req.query.estado : 'observada';
      const [r] = await portalPool.query(
        `SELECT m.id, m.usuario, p.nombre, DATE_FORMAT(m.fecha,'%Y-%m-%d') AS fecha, m.tipo,
           DATE_FORMAT(m.ts,'%Y-%m-%d %H:%i:%s') AS ts, m.metodo, m.lat, m.lng, m.precision_m, m.distancia_m,
           m.ip, m.equipo, m.agente, m.estado, m.motivos, m.nota_trabajador, m.revisado_por, m.nota_revision,
           m.creado_por, s.nombre AS sede
         FROM asist_marcas m LEFT JOIN asist_personal p ON p.usuario=m.usuario LEFT JOIN asist_sedes s ON s.id=m.sede_id
         WHERE m.estado=? ORDER BY m.fecha DESC, m.ts DESC LIMIT 300`, [estado]);
      res.json(r.map(m => ({ ...m, hora: horaLimaDe(deUtcSql(m.ts)), lat: m.lat == null ? null : Number(m.lat), lng: m.lng == null ? null : Number(m.lng) })));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Aprobar o rechazar una marca observada
  app.post('/api/asistencia/admin/revisar', authAdmin, mAsis, async (req, res) => {
    try {
      await asegurarTablas();
      const { id, estado, nota } = req.body || {};
      if (!['aprobada', 'rechazada'].includes(estado)) return res.status(400).json({ error: 'Estado inválido' });
      const [r] = await portalPool.query(
        `UPDATE asist_marcas SET estado=?, revisado_por=?, revisado_ts=UTC_TIMESTAMP(), nota_revision=? WHERE id=?`,
        [estado, quien(req), recortar(nota, 300) || null, Number(id) || 0]);
      if (!r.affectedRows) return res.status(404).json({ error: 'Marca no encontrada' });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Marca manual (olvidó marcar, se le cayó el celular…). Queda registrado quién la puso.
  app.post('/api/asistencia/admin/marca-manual', authAdmin, mAsis, async (req, res) => {
    try {
      await asegurarTablas();
      const { usuario, fecha, hora, tipo, nota } = req.body || {};
      if (!usuario || !fechaValida(fecha) || !horaValida(hora) || !['entrada', 'salida'].includes(tipo))
        return res.status(400).json({ error: 'Completa trabajador, fecha, hora y tipo.' });
      if (!recortar(nota, 300)) return res.status(400).json({ error: 'Escribe el motivo de la marca manual.' });
      const ts = new Date(Date.parse(fecha + 'T' + hora + ':00Z') + OFFSET_LIMA_MS);
      if (ts > new Date()) return res.status(400).json({ error: 'No se puede marcar una hora futura.' });
      await fichaDe(usuario);
      await portalPool.query(
        `INSERT INTO asist_marcas (usuario, fecha, tipo, ts, metodo, estado, motivos, nota_revision, revisado_por, revisado_ts, creado_por)
         VALUES (?,?,?,?,'manual','manual','Marca manual',?,?,UTC_TIMESTAMP(),?)
         ON DUPLICATE KEY UPDATE ts=VALUES(ts), metodo='manual', estado='manual', motivos=CONCAT('Corregida manualmente', IF(motivos IS NULL,'',CONCAT(' (antes: ', motivos, ')'))),
           nota_revision=VALUES(nota_revision), revisado_por=VALUES(revisado_por), revisado_ts=UTC_TIMESTAMP()`,
        [usuario, fecha, tipo, utcSql(ts), recortar(nota, 300), quien(req), quien(req)]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Personal ──
  app.get('/api/asistencia/admin/personal', authAdmin, mAsis, async (req, res) => {
    try {
      await asegurarTablas();
      const activos = await sincronizarPersonal();
      const [r] = await portalPool.query(
        `SELECT p.*, (SELECT DATE_FORMAT(MAX(g.ts),'%Y-%m-%d %H:%i:%s') FROM asist_geo g WHERE g.usuario=p.usuario) AS ult_geo,
           (SELECT g.evento FROM asist_geo g WHERE g.usuario=p.usuario AND g.evento<>'latido' ORDER BY g.ts DESC LIMIT 1) AS ult_evento
         FROM asist_personal p ORDER BY p.controlar DESC, p.nombre, p.usuario`);
      const c = await leerConfig();
      r.forEach(p => {
        p.horario_propio = horarioPropio(p, c);
        p.horario = horarioDe(p, c);
        if (p.ult_geo) { const d = deUtcSql(p.ult_geo); p.ult_geo = fechaLimaDe(d) + ' ' + horaLimaDe(d); }
        p.tiene_geo = !!p.geo_token; delete p.geo_token; // la clave solo se muestra al generarla
      });
      res.json(r.map(p => ({ ...p, equipos: parsearEquipos(p.equipos), en_railway: activos.has(p.usuario) || p.usuario === process.env.ADMIN_USER })));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/asistencia/admin/personal', authAdmin, mAsis, async (req, res) => {
    try {
      await asegurarTablas();
      const b = req.body || {};
      if (!b.usuario) return res.status(400).json({ error: 'Falta el usuario' });
      let h = null;
      try { h = horarioDeBody(b.horario); } catch (err) { return res.status(400).json({ error: err.message }); }
      if (b.horario && !h) return res.status(400).json({ error: 'Marca al menos un día laborable' });
      await fichaDe(b.usuario);
      // horario null = usa el general. Se limpian los campos sueltos de la versión anterior.
      await portalPool.query(
        `UPDATE asist_personal SET nombre=?, controlar=?, horario_json=?, hora_entrada=NULL, hora_salida=NULL, dias=NULL, prod_user_id=? WHERE usuario=?`,
        [recortar(b.nombre, 120) || b.usuario, b.controlar ? 1 : 0, h ? aJson(h) : null, Number(b.prod_user_id) || null, b.usuario]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Quitar un equipo registrado (cambió de celular, etc.)
  app.post('/api/asistencia/admin/personal/quitar-equipo', authAdmin, mAsis, async (req, res) => {
    try {
      await asegurarTablas();
      const { usuario, equipo } = req.body || {};
      const p = await fichaDe(usuario);
      const lista = equipo ? parsearEquipos(p.equipos).filter(e => e.id !== equipo) : [];
      await portalPool.query(`UPDATE asist_personal SET equipos=? WHERE usuario=?`, [JSON.stringify(lista), usuario]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Generar (o quitar) la clave del celular de empresa para la geocerca
  app.post('/api/asistencia/admin/personal/geo-token', authAdmin, mAsis, async (req, res) => {
    try {
      await asegurarTablas();
      const { usuario, quitar } = req.body || {};
      if (!usuario) return res.status(400).json({ error: 'Falta el usuario' });
      await fichaDe(usuario);
      const token = quitar ? null : require('crypto').randomBytes(20).toString('hex');
      await portalPool.query(`UPDATE asist_personal SET geo_token=? WHERE usuario=?`, [token, usuario]);
      res.json({ ok: true, token });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Usuarios del sistema principal (para vincular la actividad)
  app.get('/api/asistencia/admin/usuarios-sistema', authAdmin, mAsis, async (req, res) => {
    try {
      const [r] = await prodPool.query(`SELECT id, name FROM users ORDER BY name`);
      const fuentes = await fuentesActividad().catch(() => []);
      res.json({ usuarios: r, fuentes: fuentes.map(f => f.tabla) });
    } catch (e) { res.status(500).json({ error: 'No se pudo leer usuarios del sistema: ' + e.message }); }
  });

  // ── Sedes ──
  app.get('/api/asistencia/admin/sedes', authAdmin, mAsis, async (req, res) => {
    try { await asegurarTablas(); res.json({ sedes: await leerSedes(false), mi_ip: ipCliente(req) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/asistencia/admin/sedes', authAdmin, mAsis, async (req, res) => {
    try {
      await asegurarTablas();
      const b = req.body || {};
      const nombre = recortar(b.nombre, 100);
      if (!nombre) return res.status(400).json({ error: 'Ponle un nombre a la sede' });
      const lat = b.lat === '' || b.lat == null ? null : Number(b.lat);
      const lng = b.lng === '' || b.lng == null ? null : Number(b.lng);
      if ((lat != null && (!isFinite(lat) || Math.abs(lat) > 90)) || (lng != null && (!isFinite(lng) || Math.abs(lng) > 180)))
        return res.status(400).json({ error: 'Coordenadas inválidas' });
      const radio = Math.min(2000, Math.max(20, Number(b.radio_m) || 100));
      const ips = listaIps(b.ips).join(', ').slice(0, 500);
      const vals = [nombre, lat, lng, radio, ips, b.activo === false || b.activo === 0 ? 0 : 1];
      if (b.id) await portalPool.query(`UPDATE asist_sedes SET nombre=?, lat=?, lng=?, radio_m=?, ips=?, activo=? WHERE id=?`, [...vals, Number(b.id)]);
      else await portalPool.query(`INSERT INTO asist_sedes (nombre, lat, lng, radio_m, ips, activo) VALUES (?,?,?,?,?,?)`, vals);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/asistencia/admin/sedes/eliminar', authAdmin, mAsis, async (req, res) => {
    try { await asegurarTablas(); await portalPool.query(`DELETE FROM asist_sedes WHERE id=?`, [Number((req.body || {}).id) || 0]); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Configuración general ──
  app.get('/api/asistencia/admin/config', authAdmin, mAsis, async (req, res) => {
    try { await asegurarTablas(); const c = await leerConfig(); res.json({ ...c, horario: horarioGeneral(c) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/asistencia/admin/config', authAdmin, mAsis, async (req, res) => {
    try {
      await asegurarTablas();
      const b = req.body || {};
      let h;
      try { h = horarioDeBody(b.horario); } catch (err) { return res.status(400).json({ error: err.message }); }
      if (!h) return res.status(400).json({ error: 'Marca al menos un día laborable' });
      const d1 = h[1] || Object.values(h)[0], dias = Object.keys(h).join(',');
      const ent = (v, min, max, def) => { const n = Math.round(Number(v)); return isFinite(n) ? Math.min(max, Math.max(min, n)) : def; };
      const tz = ['+00:00', '-05:00'].includes(b.prod_tz) ? b.prod_tz : '+00:00';
      await portalPool.query(
        `UPDATE asist_config SET horario_json=?, hora_entrada=?, hora_salida=?, dias=?, tolerancia_min=?, precision_max_m=?, min_jornada_min=?, prod_tz=? WHERE id=1`,
        [aJson(h), d1.entrada, d1.salida, dias, ent(b.tolerancia_min, 0, 120, 10), ent(b.precision_max_m, 20, 2000, 150),
          ent(b.min_jornada_min, 0, 600, 30), tz]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Excel ──
  app.get('/api/asistencia/admin/excel', authAdmin, mAsis, async (req, res) => {
    try {
      await asegurarTablas();
      const ExcelJS = require('exceljs');
      const { desde, hasta } = rangoDe(req.query);
      const r = await construirResumen(desde, hasta);
      const wb = new ExcelJS.Workbook();
      const cabecera = (ws, cols) => {
        cols.forEach((c, i) => { ws.getColumn(i + 1).width = c[1]; });
        const hr = ws.addRow(cols.map(c => c[0]));
        hr.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        hr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF000726' } };
        return hr.number;
      };
      const hhmm = m => m == null ? '' : `${Math.floor(m / 60)}:${p2(m % 60)}`;
      const sgn = m => m == null ? '' : (m < 0 ? '-' : '+') + hhmm(Math.abs(m));
      const ESTADO = { completo: 'Completo', en_curso: 'En curso', sin_salida: 'Sin salida', pendiente: 'Pendiente', falta: 'Falta', sin_entrada: 'Sin entrada' };
      const DIAS = ['', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

      const ws1 = wb.addWorksheet('Resumen');
      cabeceraExcel(ws1, 'Asistencia — resumen', [['Desde', desde], ['Hasta', hasta]], 13);
      const h1 = cabecera(ws1, [['Trabajador', 26], ['Días laborables', 14], ['Asistió', 10], ['Faltas', 10], ['Tardanzas', 11],
        ['Min. tardanza', 13], ['Sin salida', 11], ['Horas trabajadas', 15], ['Observadas', 12], ['Salidas del local', 15], ['Tiempo fuera', 12], ['Tard. compensadas', 15], ['Saldo de horas', 14]]);
      r.totales.forEach(t => ws1.addRow([t.nombre, t.dias_lab, t.asistidos, t.faltas, t.tardanzas, t.min_tardanza, t.sin_salida, hhmm(t.min_trabajados), t.observadas, t.salidas, hhmm(t.min_fuera), t.compensadas, sgn(t.saldo)]));
      ws1.views = [{ state: 'frozen', ySplit: h1 }];

      const ws2 = wb.addWorksheet('Detalle diario');
      cabeceraExcel(ws2, 'Asistencia — detalle diario', [['Desde', desde], ['Hasta', hasta]], 18);
      const h2 = cabecera(ws2, [['Fecha', 11], ['Día', 6], ['Trabajador', 24], ['Horario', 12], ['Entrada', 9], ['Salida', 9],
        ['Horas', 8], ['Saldo', 8], ['Tardanza (min)', 13], ['Salió antes (min)', 15], ['Estado', 12], ['1ª acción sistema', 15],
        ['Últ. acción sistema', 16], ['Min. hasta 1ª acción', 17], ['Acciones', 9], ['Fuera del local', 26], ['Observaciones', 40], ['Nota trabajador', 30]]);
      r.filas.forEach(f => ws2.addRow([f.fecha, DIAS[f.dia], f.nombre, f.horario, f.entrada || '', f.salida || '',
        hhmm(f.min_trabajados), sgn(f.saldo), f.min_tardanza ? f.min_tardanza + (f.tardanza_compensada ? ' (compensada)' : '') : '', f.min_salida_antes || '', ESTADO[f.estado] || f.estado,
        f.act_primera || '', f.act_ultima || '', f.min_hasta_actividad == null ? '' : f.min_hasta_actividad, f.act_acciones || '',
        (f.fuera || []).map(x => `${x.desde}–${x.hasta || '…'} (${x.min} min)`).join(', '),
        f.motivos, f.notas]));
      ws2.views = [{ state: 'frozen', ySplit: h2 }];
      ws2.autoFilter = { from: { row: h2, column: 1 }, to: { row: h2, column: 18 } };

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${nombreTrazable('asistencia')}.xlsx"`);
      await wb.xlsx.write(res);
      res.end();
    } catch (e) { res.status(500).json({ error: 'Error al generar el Excel: ' + e.message }); }
  });

  return { prepararTablas: asegurarTablas, _test: { salidasEn, distanciaM, ipCliente, fechaLimaDe, horaLimaDe, diaSemana } };
};
