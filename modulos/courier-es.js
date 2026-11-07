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
  arrival: 'llegada', departure: 'salida', attempt: 'intento', attempted: 'intentado', failed: 'fallido', signed: 'firmado', door: 'puerta',
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
// Separa un desc antiguo "estado · lugar" (guardado antes de esta versión).
function separar(desc) {
  const p = String(desc || '').split(' · ');
  return { texto: norm(p[0]), lugar: norm(p.slice(1).join(' · ')) };
}
// Frase a traducir de un evento (nuevo: ev.raw; antiguo: la primera parte de ev.desc).
function fraseEvento(ev) { return ev && ev.raw != null ? norm(ev.raw) : separar(ev && ev.desc).texto; }

/**
 * Texto final en español de un evento.
 * @param ev     { raw?, lugar?, codigo?, desc? }
 * @param cache  Map clave(en) → es (traducciones de la IA)
 */
function textoEvento(ev, cache) {
  const frase = fraseEvento(ev);
  const lugar = ev && ev.raw != null ? norm(ev.lugar) : separar(ev && ev.desc).lugar;
  let es = '';
  if (frase) {
    const c = cache && cache.get(clave(frase));
    if (c) es = c;
    else if (!quedaIngles(frase)) es = traducirDic(frase);
    else {
      const cod = String((ev && ev.codigo) || '').toLowerCase();
      // El diccionario no alcanza: si hay código del courier, usar su etiqueta + la traducción aproximada entre paréntesis no aporta; se usa la aproximada.
      es = traducirDic(frase) || CODIGO_ES[cod] || '';
    }
  } else {
    es = CODIGO_ES[String((ev && ev.codigo) || '').toLowerCase()] || '';
  }
  const lug = traducirLugar(lugar);
  return [capitalizar(es), lug].filter(Boolean).join(' · ').slice(0, 300);
}
function textoResumen(mile, resumen, cache) {
  const m = MILE_ES[String(mile || '').toLowerCase()];
  if (m) return m;
  const c = cache && cache.get(clave(resumen));
  return c ? capitalizar(c) : traducirDic(resumen);
}

module.exports = { textoEvento, textoResumen, traducirDic, traducirLugar, quedaIngles, fraseEvento, clave, norm, CODIGO_ES, MILE_ES };
