// ═══════════════════════════════════════════════════════════════════════════
//  Traducción al español de los estados del courier (FedEx, UPS, DHL, USPS…)
//  Funciones PURAS (sin base de datos ni red), usadas por modulos/seguimiento.js.
//
//  Orden de traducción de cada frase del courier:
//    1) Traducción guardada (hecha por la IA y cacheada en seg_traducciones).
//    2) Diccionario de frases típicas de los couriers (abajo).
//    3) Diccionario palabra por palabra para lo que quede en inglés.
//  `necesitaIA(frase)` dice si el diccionario de frases NO alcanzó (quedan
//  palabras en inglés) → seguimiento.js la manda a traducir con la IA y la
//  guarda, así la próxima vez sale bien sin volver a llamar a la IA.
// ═══════════════════════════════════════════════════════════════════════════

const CARRIERS = ['FedEx', 'UPS', 'DHL', 'USPS', 'TNT', 'GLS', 'DPD', 'SEUR', 'Aramex', 'OnTrac', 'LaserShip', 'Amazon', 'Royal Mail', 'Purolator', 'Canada Post', 'Hermes', 'Evri', 'Yodel', 'Parcelforce', 'Chronopost', 'Colissimo', 'Bpost', 'PostNL', 'Deutsche Post', 'Poste Italiane', 'MRW', 'Nacex', 'CTT', 'Zeleris', 'Paack', 'Sendle'];
const RX_CARR = '(?:' + CARRIERS.map(c => c.replace(/ /g, '\\s+')).join('|') + ')';

// Etiquetas por código de estado (Ship24 statusCode / 17track sub_status).
const CODIGO_ES = {
  data_order_created: 'Pedido registrado por el remitente', data_order_cancelled: 'Pedido cancelado',
  transit_pickup: 'Recogido por el courier', transit_departure: 'Salió del centro de distribución',
  transit_arrival: 'Llegó al centro de distribución', transit_customs_arrival: 'Llegó a aduana',
  transit_customs_inspecting: 'En revisión de aduana', transit_customs_released: 'Liberado por aduana',
  delivery_out_for_delivery: 'En reparto', delivery_delivered: 'Entregado', delivery_ready_for_pickup: 'Disponible para recojo',
  delivery_rescheduled: 'Entrega reprogramada', exception_on_hold: 'Retenido', exception_delayed: 'Retrasado',
  exception_customs: 'Incidencia en aduana', exception_failed_attempt: 'Intento de entrega fallido',
  exception_return: 'En devolución al remitente', exception_returned: 'Devuelto al remitente',
  exception_lost: 'Extraviado', exception_damage: 'Dañado', exception_cancelled: 'Envío cancelado',
  // 17track
  inforeceived: 'Información recibida', intransit_pickedup: 'Recogido por el courier', intransit_departure: 'Salió del centro de distribución',
  intransit_arrival: 'Llegó al centro de distribución', intransit_customsprocessing: 'En proceso de aduana',
  intransit_customsreleased: 'Liberado por aduana', intransit_customsrequiringinformation: 'Aduana solicita información',
  intransit_other: 'En tránsito', outfordelivery_other: 'En reparto', delivered_other: 'Entregado',
  availableforpickup_other: 'Disponible para recojo', exception_other: 'Incidencia', expired_other: 'Sin novedades (vencido)',
  deliveryfailure_other: 'Intento de entrega fallido', notfound_other: 'Aún sin información del courier',
};
const MILE_ES = { pending: 'Pendiente', info_received: 'Información recibida', in_transit: 'En tránsito', out_for_delivery: 'En reparto', failed_attempt: 'Intento de entrega fallido', available_for_pickup: 'Disponible para recojo', delivered: 'Entregado', exception: 'Incidencia', expired: 'Sin novedades (vencido)' };

// Frases típicas (se aplican en orden; las más específicas primero). Trabajan sobre texto en minúsculas.
const C = RX_CARR;
// "a FedEx regional distribution facility", "the USPS origin facility"…
const LUGAR = `(?:a |an |the )?(?:${C} )?(?:(?:regional|origin|destination|local|international|network|distribution|processing|sort|sorting|delivery|service|transit|main|export|import)\\s+)*(?:hub|facility|location|center|centre|ramp|gateway|airport|station|terminal|depot|warehouse)`;
const FRASES = [
  [new RegExp(`shipper created a label,? ${C} has not received the package yet\\.?`, 'i'), 'el remitente creó la etiqueta; el courier aún no recibe el paquete'],
  [new RegExp(`shipment information sent to ${C}`, 'i'), 'el remitente registró el envío en el courier'],
  [/(?:the )?sender (?:has )?created (?:a|the) (?:shipping )?label/i, 'el remitente creó la etiqueta'],
  [/(?:shipping )?label (?:has been )?created(?:,? the status will be updated when shipment begins to travel)?/i, 'etiqueta creada'],
  [/pre-?shipment info(?:rmation)? sent to \w+/i, 'el remitente registró el envío en el courier'],
  [/(?:shipment |order |electronic )?(?:information|info|notification|data) (?:was )?received(?: by \w+)?/i, 'información del envío recibida'],
  [/(?:shipping )?pre-?alert(?:ed)?|pre-?advice(?: received)?/i, 'información del envío recibida'],
  [new RegExp(`(?:on ${C} vehicle|on vehicle|loaded on delivery vehicle|with delivery courier|out for delivery)(?: for delivery)?(?: today)?`, 'i'), 'en reparto'],
  [/delivered,? (?:signed for by|left at|received by)/i, 'entregado, recibido por'],
  [/signed for by/i, 'recibido por'],
  [/delivered to (?:agent|access point|parcel ?locker|front door|mailroom|reception|receptionist|front desk)/i, 'entregado en recepción'],
  [/delivered/i, 'entregado'],
  [new RegExp(`left ${C} origin facility|left origin facility|departed (?:from )?origin facility`, 'i'), 'salió del centro de origen'],
  [new RegExp(`(?:(?:shipment|package|parcel|item) )?(?:has )?(?:departed|left) (?:from )?${LUGAR}`, 'i'), 'salió del centro de distribución'],
  [new RegExp(`(?:(?:shipment|package|parcel|item) )?(?:has )?arrived (?:at|in) ${LUGAR}`, 'i'), 'llegó al centro de distribución'],
  [new RegExp(`accepted at ${LUGAR}`, 'i'), 'aceptado en el centro de origen'],
  [/(?:the )?(?:package|parcel|item) is at the (?:local )?post office/i, 'el paquete está en la oficina de correos local'],
  [/departed (?:the )?post office/i, 'salió de la oficina de correos'],
  [/(?:your )?(?:package|parcel|shipment|item) will arrive later than expected/i, 'tu paquete llegará más tarde de lo previsto'],
  [/arriving late/i, 'llegará con retraso'], [/arriving on time/i, 'llegará a tiempo'],
  [/awaiting item/i, 'esperando el paquete'], [/order processed/i, 'pedido procesado'],
  [/(?:your )?(?:package|parcel|shipment|item) (?:is |has been )?delayed/i, 'tu paquete está retrasado'],
  [/(?:shipment|package|parcel|item) is on hold/i, 'retenido'],
  [/delivery (?:date )?(?:updated|changed)/i, 'fecha de entrega actualizada'],
  [/in\/at mailbox/i, 'en el buzón'],
  [/customs status updated/i, 'estado de aduana actualizado'],
  [new RegExp(`(?:departed|left) (?:from )?(?:${C} )?(?:hub|facility|location|sort facility|sorting center|processing center|ramp|gateway|airport)`, 'i'), 'salió del centro de distribución'],
  [new RegExp(`arrived at (?:${C} )?(?:destination )?(?:hub|facility|location|sort facility|sorting center|processing center|ramp|gateway|airport|delivery facility|delivery station)`, 'i'), 'llegó al centro de distribución'],
  [new RegExp(`at (?:local|destination) (?:${C} )?(?:facility|sort facility|hub|station)`, 'i'), 'en el centro de distribución de destino'],
  [new RegExp(`(?:processing|processed) at (?:${C} )?(?:origin )?(?:facility|hub|sort facility|location)`, 'i'), 'en proceso en el centro de distribución'],
  [/(?:at|in) (?:the )?(?:\w+ )?sort(?:ing)? (?:facility|center)/i, 'en el centro de distribución'],
  // Formas mixtas guardadas por la versión anterior (traducción parcial palabra a palabra).
  [new RegExp(`llegó a (?:${C} )?(?:location|facility|hub|ramp|gateway|sort facility|centro de distribución)`, 'i'), 'llegó al centro de distribución'],
  [new RegExp(`salió de (?:${C} )?(?:location|facility|hub|ramp|gateway|sort facility|centro de distribución|origen facility|origin facility)`, 'i'), 'salió del centro de distribución'],
  [/arrival scan/i, 'escaneo de llegada'], [/departure scan/i, 'escaneo de salida'], [/origin scan/i, 'escaneo en origen'],
  [/destination scan/i, 'escaneo en destino'], [/import scan/i, 'escaneo de importación'], [/export scan/i, 'escaneo de exportación'],
  [/we have your package/i, 'el courier ya tiene tu paquete'],
  [/your (?:package|parcel|shipment|item) is (?:in transit|on (?:the|its) way)(?: to the next facility)?/i, 'tu paquete está en camino'],
  [/(?:package|parcel|shipment|item) (?:is )?(?:in transit|on (?:the|its) way)(?: to the next facility)?/i, 'el paquete está en camino'],
  [/(?:on the way|on its way|en route|moving through network|in transit to (?:next|destination) facility)/i, 'en camino'],
  [/in transit/i, 'en tránsito'],
  [/international shipment release\s*-\s*import/i, 'liberado por aduana (importación)'],
  [/international shipment release\s*-\s*export/i, 'liberado por aduana (exportación)'],
  [/international shipment release/i, 'liberado por aduana'],
  [/(?:customs )?clearance delay/i, 'demora en aduana'],
  [/(?:package )?available for clearance/i, 'disponible para despacho de aduana'],
  [/(?:customs )?clearance (?:processing )?(?:complete|completed|event)|cleared customs|released by customs|customs released/i, 'despacho de aduana completado'],
  [/(?:customs )?clearance (?:in progress|processing)|(?:in|under) customs (?:clearance|processing)|customs processing/i, 'en proceso de aduana'],
  [/held (?:by|in|at) customs/i, 'retenido en aduana'],
  [/delivery exception/i, 'incidencia en la entrega'], [/shipment exception/i, 'incidencia en el envío'],
  [/customer not available or business closed/i, 'cliente ausente o negocio cerrado'],
  [/(?:the )?business (?:was )?closed/i, 'negocio cerrado'],
  [/(?:delivery )?attempt(?:ed)?(?: delivery)?(?: made)?|delivery (?:was )?attempted/i, 'intento de entrega'],
  [/(?:incorrect|incomplete) address/i, 'dirección incorrecta o incompleta'],
  [/(?:returned|return) to (?:sender|shipper)/i, 'devuelto al remitente'],
  [/(?:on )?hold|held/i, 'retenido'],
  [/post office/i, 'oficina de correos'], [/tendered to/i, 'entregado a'], [/forwarded to/i, 'reenviado a'], [/transferred to/i, 'transferido a'],
  [new RegExp(`ready for ${C}`, 'i'), 'listo para el courier'],
  [/(?:package|parcel|shipment) (?:was )?(?:picked up|collected)|picked up|pickup (?:scan|completed)|collected/i, 'recogido por el courier'],
  [/(?:package|parcel|shipment|item) (?:was )?received/i, 'paquete recibido'],
  [/accepted (?:at|by)/i, 'aceptado en'],
  [/(?:shipment )?(?:is )?delayed|delay(?:ed)?/i, 'retrasado'],
  [/weather/i, 'clima'],
  [/(?:scheduled|estimated) delivery(?: date)? (?:updated|changed|rescheduled)/i, 'fecha de entrega actualizada'],
  [/rescheduled/i, 'reprogramado'],
];

// Palabras sueltas (para lo que el diccionario de frases no cubrió).
const PALABRAS = {
  shipment: 'envío', package: 'paquete', parcel: 'paquete', item: 'artículo', items: 'artículos', arrived: 'llegó', arrives: 'llega', arriving: 'llegando',
  departed: 'salió', departs: 'sale', left: 'salió', facility: 'centro', hub: 'centro', sort: 'clasificación', sorting: 'clasificación', origin: 'origen',
  destination: 'destino', local: 'local', vehicle: 'vehículo', delivery: 'entrega', deliver: 'entregar', customs: 'aduana', clearance: 'despacho',
  scan: 'escaneo', scanned: 'escaneado', received: 'recibido', processing: 'en proceso', processed: 'procesado', transit: 'tránsito',
  label: 'etiqueta', created: 'creada', information: 'información', info: 'información', sent: 'enviada', picked: 'recogido', pickup: 'recojo',
  network: 'red', next: 'siguiente', location: 'local', station: 'estación', airport: 'aeropuerto', flight: 'vuelo', loaded: 'cargado',
  unloaded: 'descargado', container: 'contenedor', trailer: 'tráiler', truck: 'camión', export: 'exportación', import: 'importación',
  international: 'internacional', released: 'liberado', release: 'liberación', exception: 'incidencia', delay: 'retraso', delayed: 'retrasado',
  address: 'dirección', customer: 'cliente', recipient: 'destinatario', sender: 'remitente', shipper: 'remitente', consignee: 'destinatario',
  returned: 'devuelto', return: 'devolución', available: 'disponible', ready: 'listo', expected: 'esperado', estimated: 'estimado',
  scheduled: 'programado', updated: 'actualizado', update: 'actualización', date: 'fecha', today: 'hoy', tomorrow: 'mañana', yet: 'aún',
  service: 'servicio', partner: 'socio', carrier: 'courier', courier: 'courier', handed: 'entregado', over: '', moving: 'en movimiento',
  through: 'por', way: 'camino', country: 'país', region: 'región', warehouse: 'almacén', depot: 'depósito', terminal: 'terminal',
  the: '', an: '', at: 'en', to: 'a', from: 'desde', by: 'por', for: 'para', and: 'y', in: 'en', on: 'en', of: 'de', with: 'con',
  your: 'tu', our: 'nuestro', has: '', have: '', been: '', is: 'está', are: 'están', was: 'fue', were: 'fueron', not: 'no', will: '', be: '',
  it: '', its: 'su', this: 'este', that: 'que', please: 'por favor', contact: 'contactar', may: 'puede', due: 'debido', missing: 'falta',
  documents: 'documentos', document: 'documento', payment: 'pago', duties: 'aranceles', taxes: 'impuestos', paid: 'pagado', required: 'requerido',
  accepted: 'aceptado', arrival: 'llegada', departure: 'salida', attempt: 'intento', attempted: 'intentado', failed: 'fallido', signed: 'firmado', door: 'puerta',
  ramp: 'rampa', gateway: 'centro de conexión', office: 'oficina', post: 'correo', mail: 'correo', center: 'centro', centre: 'centro',
  plant: 'planta', port: 'puerto', vessel: 'buque', cargo: 'carga', tracking: 'seguimiento', number: 'número', signature: 'firma',
  front: 'frontal', business: 'negocio', closed: 'cerrado', weather: 'clima', operational: 'operativo', reasons: 'razones', unable: 'no se pudo',
};
// Palabras que delatan que la frase sigue en inglés (para pedir traducción a la IA).
const INGLES = new Set(Object.keys(PALABRAS).filter(w => w.length > 2 && !['local', 'terminal', 'transit', 'info', 'courier', 'hub'].includes(w))
  .concat(['mailbox', 'late', 'awaiting', 'expected', 'later', 'order', 'regional', 'up', 'out', 'into', 'onto', 'than', 'then', 'there', 'their', 'which', 'when', 'what', 'who', 'yet', 'did', 'does', 'had', 'should', 'would', 'could', 'can']));

// Países frecuentes en las ubicaciones del courier.
const PAISES = [[/\bunited states(?: of america)?\b/ig, 'Estados Unidos'], [/\bspain\b/ig, 'España'], [/\bperu\b/ig, 'Perú'], [/\bgermany\b/ig, 'Alemania'],
  [/\bnetherlands\b/ig, 'Países Bajos'], [/\bunited kingdom\b|\bgreat britain\b/ig, 'Reino Unido'], [/\bfrance\b/ig, 'Francia'], [/\bitaly\b/ig, 'Italia'],
  [/\bbelgium\b/ig, 'Bélgica'], [/\bswitzerland\b/ig, 'Suiza'], [/\bjapan\b/ig, 'Japón'], [/\bmexico\b/ig, 'México'], [/\bpanama\b/ig, 'Panamá'],
  [/\bcanada\b/ig, 'Canadá'], [/\bpoland\b/ig, 'Polonia'], [/\bczech republic\b|\bczechia\b/ig, 'República Checa'], [/\bdenmark\b/ig, 'Dinamarca'],
  [/\bsweden\b/ig, 'Suecia'], [/\bhong kong\b/ig, 'Hong Kong'], [/\bsouth korea\b|\bkorea\b/ig, 'Corea del Sur']];

const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim();
const clave = (t) => norm(t).toLowerCase().slice(0, 255);

function capitalizar(x) {
  x = norm(x).replace(/\s+([,.;:])/g, '$1').replace(/^[,;:\s-]+|[,;:\s-]+$/g, '');
  // Nombres de courier con su mayúscula correcta.
  CARRIERS.forEach(c => { x = x.replace(new RegExp('\\b' + c.replace(/ /g, '\\s+') + '\\b', 'ig'), c); });
  return x ? x.charAt(0).toUpperCase() + x.slice(1) : '';
}
// Aplica solo el diccionario de frases (sin palabra por palabra).
function soloFrases(t) {
  let x = ' ' + norm(t) + ' ';
  FRASES.forEach(([rx, es]) => { x = x.replace(new RegExp(rx.source, 'ig'), ' ' + es + ' '); });
  return norm(x);
}
// ¿Sigue habiendo palabras en inglés después del diccionario de frases?
function quedaIngles(t) {
  // Frases de 1–2 palabras conocidas ("Departed", "Accepted", "Processed") las resuelve el diccionario.
  const pal = norm(t).toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
  if (pal.length && pal.length <= 2 && pal.every(w => Object.prototype.hasOwnProperty.call(PALABRAS, w) && PALABRAS[w])) return false;
  const ws = soloFrases(t).toLowerCase().replace(/[^a-záéíóúñü\s]/g, ' ').split(/\s+/).filter(Boolean);
  return ws.filter(w => INGLES.has(w)).length > 0;
}
// Traducción por diccionario (frases + palabras sueltas). Idempotente sobre texto ya en español.
function traducirDic(t) {
  if (!norm(t)) return '';
  let x = soloFrases(t);
  x = x.replace(/[A-Za-zÀ-ÿ]+(?:'[a-z]+)?/g, (w) => {
    if (/[^A-Za-z']/.test(w)) return w;                      // palabra con tilde/ñ → ya está en español
    const k = w.toLowerCase();
    if (/^[A-Z0-9]{2,}$/.test(w) && !Object.prototype.hasOwnProperty.call(PALABRAS, k)) return w;   // siglas / códigos
    return Object.prototype.hasOwnProperty.call(PALABRAS, k) ? PALABRAS[k] : w;
  });
  return capitalizar(x);
}
function traducirLugar(l) {
  let x = norm(l);
  if (!x) return '';
  // "MIAMI, FL, US" → "Miami, FL, US": cada parte en MAYÚSCULAS de 3+ letras pasa a Tipo Título.
  x = x.split(/\s*,\s*/).map(p => (p.length > 2 && p === p.toUpperCase() && /[A-Z]/.test(p))
    ? p.toLowerCase().replace(/(^|[\s(/-])([a-záéíóúñ])/g, (m, a, c) => a + c.toUpperCase()) : p).join(', ');
  PAISES.forEach(([rx, es]) => { x = x.replace(rx, es); });
  return x.slice(0, 120);
}
// ── Ciudad y país de cada evento ──────────────────────────────────────────
//    El courier manda la ubicación como texto libre: "MEMPHIS, TN, US",
//    "Miami, FL 33166, United States", "LEIPZIG - GERMANY", "TAIPEI, TW",
//    "CINCINNATI HUB - USA"… (DHL a veces la pone dentro del estado:
//    "Processed at LEIPZIG - GERMANY"). Se separa en ciudad, estado y país.
const sinTildes = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const U = (t) => sinTildes(t).toUpperCase().replace(/[.’']/g, '').replace(/\s+/g, ' ').trim();
let REG_ES = null, REG_EN = null;
try { REG_ES = new Intl.DisplayNames(['es'], { type: 'region' }); REG_EN = new Intl.DisplayNames(['en'], { type: 'region' }); } catch (e) { /* sin ICU */ }
const PAIS_CORTO = { HK: 'Hong Kong', MO: 'Macao', US: 'Estados Unidos', GB: 'Reino Unido', KR: 'Corea del Sur', TW: 'Taiwán', CN: 'China', CZ: 'República Checa', NL: 'Países Bajos', AE: 'Emiratos Árabes Unidos', PE: 'Perú' };
const ISO2 = [];
const NOMBRE_ISO = new Map();
if (REG_EN) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (const a of A) for (const b of A) {
    const c = a + b; let en = '';
    try { en = REG_EN.of(c); } catch (e) { continue; }
    if (!en || en === c || /unknown/i.test(en) || ['EU', 'EZ', 'UN', 'UK', 'QO', 'XA', 'XB', 'ZZ'].includes(c)) continue;
    ISO2.push(c); NOMBRE_ISO.set(U(en), c);
    try { NOMBRE_ISO.set(U(REG_ES.of(c)), c); } catch (e) {}
  }
}
const ISO2_SET = new Set(ISO2.length ? ISO2 : ['US', 'ES', 'PE', 'CN', 'TW', 'DE', 'GB', 'NL', 'FR', 'IT', 'HK', 'JP', 'MX', 'PA', 'CA']);
Object.entries({ 'USA': 'US', 'U S A': 'US', 'US': 'US', 'UNITED STATES OF AMERICA': 'US', 'UNITED STATES': 'US', 'EEUU': 'US', 'EE UU': 'US', 'UK': 'GB', 'GREAT BRITAIN': 'GB', 'ENGLAND': 'GB',
  'KOREA': 'KR', 'REPUBLIC OF KOREA': 'KR', 'SOUTH KOREA': 'KR', 'CZECH REPUBLIC': 'CZ', 'HOLLAND': 'NL', 'THE NETHERLANDS': 'NL', 'CHINA MAINLAND': 'CN', 'MAINLAND CHINA': 'CN',
  'PEOPLES REPUBLIC OF CHINA': 'CN', 'HONG KONG SAR': 'HK', 'HONG KONG SAR CHINA': 'HK', 'HONG KONG': 'HK', 'TAIWAN': 'TW', 'TAIWAN CHINA': 'TW', 'CHINESE TAIPEI': 'TW', 'RUSSIA': 'RU',
  'VIETNAM': 'VN', 'TURKEY': 'TR', 'UAE': 'AE', 'PERU': 'PE', 'ESPANA': 'ES', 'DEUTSCHLAND': 'DE', 'MACAU': 'MO' }).forEach(([k, v]) => NOMBRE_ISO.set(k, v));
const ISO3 = { USA: 'US', ESP: 'ES', DEU: 'DE', GBR: 'GB', CHN: 'CN', TWN: 'TW', NLD: 'NL', PER: 'PE', FRA: 'FR', ITA: 'IT', BEL: 'BE', CHE: 'CH', JPN: 'JP', MEX: 'MX', PAN: 'PA', CAN: 'CA',
  POL: 'PL', CZE: 'CZ', DNK: 'DK', SWE: 'SE', HKG: 'HK', KOR: 'KR', AUT: 'AT', PRT: 'PT', ARE: 'AE', SGP: 'SG', THA: 'TH', VNM: 'VN', IND: 'IN', BRA: 'BR', CHL: 'CL', COL: 'CO',
  ECU: 'EC', ARG: 'AR', TUR: 'TR', AUS: 'AU', NZL: 'NZ', SVN: 'SI', SVK: 'SK', HUN: 'HU', ROU: 'RO', LUX: 'LU', IRL: 'IE', NOR: 'NO', FIN: 'FI', MYS: 'MY', IDN: 'ID', PHL: 'PH' };
const US_EST = new Set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR VI GU'.split(' '));
const CA_PROV = new Set('ON QC BC AB MB SK NS NB NL PE YT NT NU'.split(' '));
const EST_NOMBRE = { FLORIDA: 'FL', TENNESSEE: 'TN', KENTUCKY: 'KY', CALIFORNIA: 'CA', TEXAS: 'TX', OHIO: 'OH', 'NEW YORK': 'NY', 'NEW JERSEY': 'NJ', ILLINOIS: 'IL', GEORGIA: 'GA', ALASKA: 'AK', INDIANA: 'IN', 'NORTH CAROLINA': 'NC', PENNSYLVANIA: 'PA', UTAH: 'UT', COLORADO: 'CO', ARIZONA: 'AZ', WASHINGTON: 'WA' };

function paisES(iso) {
  if (!iso) return '';
  if (PAIS_CORTO[iso]) return PAIS_CORTO[iso];
  try { const n = REG_ES && REG_ES.of(iso); if (n && n !== iso) return n; } catch (e) {}
  return iso;
}
// Texto → código de país (o '' si no es un país).
function aIso(t) {
  const u = U(t);
  if (!u) return '';
  if (u.length === 2 && ISO2_SET.has(u)) return u;
  if (u.length === 3 && ISO3[u]) return ISO3[u];
  return NOMBRE_ISO.get(u) || '';
}
const titulo = (t) => {
  const x = norm(t);
  if (!x || x !== x.toUpperCase()) return x;
  return x.toLowerCase().replace(/(^|[\s(/'’-])([a-záéíóúñü])/g, (m, a, c) => a + c.toUpperCase());
};
// Palabras de instalaciones (no son ciudades): se quitan del nombre del lugar.
// "UFFICIO POSTALE ITALIA ITALIA" → (sin ciudad) Italia · "MALPENSA APT" → Malpensa · "FEDEX MEMPHIS HUB" → Memphis
const INSTALACION = new RegExp('\\b(?:' + [
  'INTERNATIONAL SERVICE CENTER', 'INTERNATIONAL AIRPORT', 'INTL AIRPORT', 'SERVICE CENTER', 'SORT(?:ING)? (?:CENTER|CENTRE|FACILITY)', 'DISTRIBUTION (?:CENTER|CENTRE)', 'PROCESSING (?:CENTER|CENTRE)',
  'LOGISTICS (?:CENTER|CENTRE)', 'DELIVERY (?:STATION|CENTER|UNIT)', 'POST OFFICE', 'POSTAL OFFICE', 'MAIL CENTER', 'FACILITY', 'GATEWAY', 'HUB', 'DEPOT', 'RAMP', 'STATION', 'WAREHOUSE',
  'AIRPORT', 'ARPT', 'APT', 'TERMINAL', 'ISC', 'NDC', 'P&DC', 'PDC', 'LON',
  'UFFICIO POSTALE', 'CENTRO (?:DI )?SMISTAMENTO', 'CENTRO OPERATIVO', 'CENTRO MECCANIZZATO POSTALE', 'CENTRO POSTALE', 'CMP', 'CPO', 'CTD', 'CDM', 'AEROPORTO',
  'OFICINA (?:DE )?CORREOS', 'CENTRO (?:DE )?(?:TRATAMIENTO|DISTRIBUCION|DISTRIBUCIÓN|CLASIFICACION|CLASIFICACIÓN)', 'AEROPUERTO', 'SUCURSAL', 'DELEGACION', 'DELEGACIÓN',
  'PAKETZENTRUM', 'BRIEFZENTRUM', 'ZUSTELLBASIS', 'CENTRE DE TRI', 'PLATEFORME', 'AGENCE',
].join('|') + ')\\b', 'ig');
const SIN_LUGAR = { ciudad: '', region: '', iso: '', pais: '' };

/**
 * Separa una ubicación del courier.
 * @param texto  "MEMPHIS, TN, US" | "LEIPZIG - GERMANY" | "Brescia (BS)" | "UFFICIO POSTALE ITALIA" …
 * @param paisesEnvio  Set de códigos de país que ya aparecen en el envío (desempata "LEIPZIG, DE": ¿Alemania o Delaware?)
 * @returns { ciudad, region, iso, pais }  (vacío si no se pudo leer)
 */
function leerLugar(texto, paisesEnvio) {
  let x = norm(texto).replace(/\b\d{4,6}(?:-\d{3,4})?\b/g, ' ').replace(/\s+,/g, ',');   // códigos postales fuera
  if (!/[A-Za-zÀ-ÿ]{2,}/.test(x)) return { ...SIN_LUGAR };                                // "19", "—": no es un lugar
  let region = '';
  // Provincia entre paréntesis: "Brescia (BS)".
  x = x.replace(/\s*\(([A-Za-z]{2,3})\)/, (m, r) => { region = r.toUpperCase(); return ''; });
  let partes = x.split(/\s*,\s*|\s+-\s+|\s*\/\s*/).map(norm).filter(p => /[A-Za-zÀ-ÿ]{2,}/.test(p));
  if (!partes.length) return { ...SIN_LUGAR };
  // Sin comas: separar al final las palabras que sean estado/país ("MIAMI FL US", "UFFICIO POSTALE ITALIA ITALIA").
  if (partes.length === 1) {
    const w = partes[0].split(' ');
    const fin = [];
    while (w.length > 1 && fin.length < 3) {
      const ult = w[w.length - 1];
      const UP = ult.toUpperCase();
      const codigo = ult === UP && ((ult.length === 2 && (US_EST.has(UP) || ISO2_SET.has(UP))) || (ult.length === 3 && ISO3[UP]));
      let nombre = 0;                                                     // nombre de país de 1 a 3 palabras ("ITALIA", "UNITED STATES")
      for (let k = Math.min(3, w.length - 1); k >= 1 && !nombre; k--) { const t = w.slice(-k).join(' '); if (t.length > 3 && NOMBRE_ISO.has(U(t))) nombre = k; }
      if (nombre) fin.unshift(w.splice(-nombre).join(' '));
      else if (codigo) fin.unshift(w.pop());
      else break;
    }
    if (fin.length) {
      // "ITALIA ITALIA": el país repetido cuenta una sola vez.
      const sinRep = fin.filter((f, i) => i === 0 || aIso(f) !== aIso(fin[i - 1]) || !aIso(f));
      partes = [w.join(' '), ...sinRep];
    }
  }
  let iso = '';
  const ultima = partes[partes.length - 1];
  const u = U(ultima);
  if (partes.length >= 2) {
    if (u.length === 2 && US_EST.has(u) && partes.length === 2 && !(paisesEnvio && paisesEnvio.has(u) && !paisesEnvio.has('US'))) { iso = 'US'; region = u; partes.pop(); }
    else if (u.length === 2 && CA_PROV.has(u) && partes.length === 2 && !ISO2_SET.has(u)) { iso = 'CA'; region = u; partes.pop(); }
    else if (EST_NOMBRE[u] && partes.length === 2) { iso = 'US'; region = EST_NOMBRE[u]; partes.pop(); }
    else { const c = aIso(ultima); if (c) { iso = c; partes.pop(); } }
  } else {
    const c = aIso(ultima);
    if (c) { iso = c; partes.pop(); }
  }
  // Estado / provincia antes del país ("MEMPHIS, TN, US").
  if (partes.length >= 2 && !region) {
    const r = U(partes[partes.length - 1]);
    if ((iso === 'US' || !iso) && (US_EST.has(r) || EST_NOMBRE[r])) { region = US_EST.has(r) ? r : EST_NOMBRE[r]; iso = iso || 'US'; partes.pop(); }
    else if ((iso === 'CA' || !iso) && CA_PROV.has(r)) { region = r; iso = iso || 'CA'; partes.pop(); }
    else if (r.length === 2 && iso && iso !== 'US' && iso !== 'CA') { region = r; partes.pop(); }
  }
  // Ciudad: la primera parte sin palabras de instalación ni nombres de courier.
  let ciudad = norm(String(partes[0] || '').replace(INSTALACION, ' ').replace(new RegExp('\\b' + RX_CARR + '\\b', 'ig'), ' '));
  ciudad = titulo(ciudad.replace(/^[\s.,;:-]+|[\s.,;:-]+$/g, ''));
  if (!/[A-Za-zÀ-ÿ]{2,}/.test(ciudad)) ciudad = '';
  if (ciudad && aIso(ciudad) && (!iso || aIso(ciudad) === iso) && U(ciudad).length > 3) { iso = iso || aIso(ciudad); ciudad = ''; }   // "Italia" sola = país
  if (ciudad && iso && (U(ciudad) === U(paisES(iso)) || NOMBRE_ISO.get(U(ciudad)) === iso)) ciudad = '';   // "Hong Kong, HK"
  if (!iso && !ciudad) return { ...SIN_LUGAR };
  return { ciudad: ciudad.slice(0, 60), region: ciudad ? region : '', iso, pais: paisES(iso) };
}
/**
 * Completa el país de los lugares que solo traen ciudad ("Brescia (BS)", "MALPENSA APT"):
 * usa el país del evento más cercano en el tiempo que sí lo tenga; si ningún evento
 * trae país, el país de origen que informa el courier.
 * @param infos  eventos ya leídos, del más reciente al más antiguo ({ ciudad, iso, pais, … })
 */
function completarPaises(infos, origenIso) {
  const conPais = infos.map((x, i) => (x.iso ? i : -1)).filter(i => i >= 0);
  infos.forEach((x, i) => {
    if (x.iso || !x.ciudad) return;
    let iso = '';
    if (conPais.length) {
      let mejor = conPais[0];
      conPais.forEach(j => { if (Math.abs(j - i) < Math.abs(mejor - i)) mejor = j; });
      iso = infos[mejor].iso;
    } else if (origenIso) iso = origenIso;
    if (iso) { x.iso = iso; x.pais = paisES(iso); x.pais_deducido = true; }
  });
  return infos;
}
function lugarTexto(L) {
  if (!L || (!L.ciudad && !L.pais)) return '';
  return [L.ciudad ? (L.ciudad + (L.region ? ' (' + L.region + ')' : '')) : '', L.pais].filter(Boolean).join(', ');
}
// DHL y otros meten la ubicación al final del estado: "Processed at LEIPZIG - GERMANY".
function lugarDentroDelEstado(raw) {
  const m = String(raw || '').match(/^(.*?)\s*\b((?:[A-Z][A-Z.'’]*)(?:\s+[A-Z][A-Z.'’]*)*)\s+-\s+([A-Z][A-Za-z .]+)$/);
  if (!m || !aIso(m[3])) return null;
  const estado = norm(m[1]).replace(/\s+(?:at|in|from|to|en|de)$/i, '');
  return { estado, lugar: m[2] + ' - ' + m[3] };
}
// Partes de un evento: frase del estado (para traducir) + ubicación cruda.
function partesEvento(ev) {
  let frase, lugar;
  if (ev && ev.raw != null) { frase = norm(ev.raw); lugar = norm(ev.lugar); }
  else { const p = separar(ev && ev.desc); frase = p.texto; lugar = p.lugar; }
  if (!lugar) { const d = lugarDentroDelEstado(frase); if (d) { frase = d.estado; lugar = d.lugar; } }
  return { frase, lugar };
}
// Países que aparecen sin ambigüedad en los eventos de un envío (+ el del almacén).
function paisesDelEnvio(eventos, hubIso) {
  const set = new Set();
  if (hubIso) set.add(hubIso);
  (eventos || []).forEach(ev => {
    const l = partesEvento(ev).lugar;
    const pts = l.split(/\s*,\s*|\s+-\s+/).filter(Boolean);
    if (pts.length >= 3 || (pts.length === 2 && U(pts[1]).length > 2)) { const c = aIso(pts[pts.length - 1]); if (c) set.add(c); }
  });
  return set;
}

// Separa un desc antiguo "estado · lugar" (guardado antes de esta versión).
function separar(desc) {
  const p = String(desc || '').split(' · ');
  return { texto: norm(p[0]), lugar: norm(p.slice(1).join(' · ')) };
}
// Frase a traducir de un evento (nuevo: ev.raw; antiguo: la primera parte de ev.desc).
function fraseEvento(ev) { return partesEvento(ev).frase; }

/**
 * Texto final en español de un evento.
 * @param ev     { raw?, lugar?, codigo?, desc? }
 * @param cache  Map clave(en) → es (traducciones de la IA)
 */
function estadoES(frase, codigo, cache) {
  if (!frase) return CODIGO_ES[String(codigo || '').toLowerCase()] || '';
  const c = cache && cache.get(clave(frase));
  if (c) return capitalizar(c);
  return traducirDic(frase) || CODIGO_ES[String(codigo || '').toLowerCase()] || '';
}
/**
 * Evento listo para mostrar.
 * @returns { desc (estado en español), ciudad, region, iso, pais, lugar (texto "Memphis (TN), Estados Unidos") }
 */
function eventoInfo(ev, cache, paisesEnvio) {
  const { frase, lugar } = partesEvento(ev);
  const L = leerLugar(lugar, paisesEnvio);
  const txt = lugarTexto(L) || (/[A-Za-zÀ-ÿ]{2,}/.test(lugar) ? traducirLugar(lugar) : '');
  return { desc: estadoES(frase, ev && ev.codigo, cache).slice(0, 255), ciudad: L.ciudad, region: L.region, iso: L.iso, pais: L.pais, lugar: txt };
}
// Compatibilidad: estado + lugar en un solo texto.
function textoEvento(ev, cache, paisesEnvio) {
  const i = eventoInfo(ev, cache, paisesEnvio);
  return [i.desc, i.lugar].filter(Boolean).join(' · ').slice(0, 300);
}
function textoResumen(mile, resumen, cache) {
  const m = MILE_ES[String(mile || '').toLowerCase()];
  if (m) return m;
  const c = cache && cache.get(clave(resumen));
  return c ? capitalizar(c) : traducirDic(resumen);
}

module.exports = { completarPaises, eventoInfo, leerLugar, lugarTexto, paisesDelEnvio, paisES, partesEvento, textoEvento, textoResumen, traducirDic, traducirLugar, quedaIngles, fraseEvento, clave, norm, CODIGO_ES, MILE_ES };
