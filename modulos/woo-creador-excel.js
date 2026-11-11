// ═══════════════════════════════════════════════════════════════════════════
//  Excel del Creador WooCommerce (modulos/woo-creador.js) — módulo propio.
//  Llena la plantilla plantillas/creacion-productos-woocommerce.xlsx:
//   · pestaña "Sistema": fila 1 (encabezados) + los datos, columnas A–AP y atributos
//   · pestaña "Para woocommerce": las fórmulas se alargan/recortan a la cantidad de filas
//     y se recalculan al abrir (Excel, Google Sheets, LibreOffice).
//  Mismo formato de filas que el exportador del ERP (simple · variable · variation).
// ═══════════════════════════════════════════════════════════════════════════
const path = require('path');
const JSZip = require('jszip');

const PLANTILLA = path.join(__dirname, '..', 'plantillas', 'creacion-productos-woocommerce.xlsx');
const HOJA_DATOS = 'Sistema';
const HOJA_FORMULAS = 'Para woocommerce';
const MAX_ATRIBUTOS = 10;

// Igual que formatDecimal() del ERP: entero sin decimales; si no, hasta 3 sin ceros sobrantes
function decimal(v) {
  if (v === null || v === undefined || v === '') return '';
  const f = Number(v); if (!isFinite(f)) return '';
  return Number.isInteger(f) ? f : Number(f.toFixed(3));
}
const nl = s => typeof s === 'string' ? s.replace(/\r\n|\r|\n/g, '\\n') : s; // saltos de línea como \n (igual que el ERP)

// Columnas de atributos (Nombre, Valor(es), Visible, Global) × MAX_ATRIBUTOS. lista = [{nombre, valores:[], visible}]
function atributos(lista) {
  const out = []; let n = 0;
  for (const a of lista) { if (n >= MAX_ATRIBUTOS) break; out.push(a.nombre, a.valores.join(', '), a.visible ? 1 : 0, 1); n++; }
  while (n++ < MAX_ATRIBUTOS) out.push('', '', '', '');
  return out;
}
// Una fila de la pestaña "Sistema" (columnas A–AP; los atributos van después)
const filaSistema = x => [
  x.id ?? '', x.tipo, x.sku, x.gtin ?? '', x.nombre, x.publicado, x.destacado, x.visibilidad, '', x.descripcion, '', '',
  'taxable', '', x.existencias || 1, x.inventario, x.bajo ?? '', x.reservas ?? 1, 0,
  x.peso, x.longitud, x.anchura, x.altura, 1, '', x.rebajado, x.normal, x.categorias, x.etiquetas, '',
  x.imagenes, '', '', x.superior, '', '', '', '', '', 0, '', ''];

// ── XML helpers ──
const escXml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
function colLetra(n) { let s = ''; n++; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
function celda(ref, v) {
  if (v === '' || v === null || v === undefined) return '';
  if (typeof v === 'number' && isFinite(v)) return `<c r="${ref}"><v>${v}</v></c>`;
  const t = String(v).slice(0, 32767);
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escXml(t)}</t></is></c>`;
}

// Rutas de las hojas por nombre (workbook.xml + rels)
async function rutasHojas(zip) {
  const wb = await zip.file('xl/workbook.xml').async('string');
  const rels = await zip.file('xl/_rels/workbook.xml.rels').async('string');
  const out = {};
  for (const m of wb.matchAll(/<sheet [^>]*name="([^"]+)"[^>]*r:id="([^"]+)"[^>]*\/>/g)) {
    const r = rels.match(new RegExp(`<Relationship [^>]*Id="${m[2]}"[^>]*Target="([^"]+)"`)) ||
              rels.match(new RegExp(`<Relationship [^>]*Target="([^"]+)"[^>]*Id="${m[2]}"`));
    if (r) out[m[1].replace(/&amp;/g, '&')] = 'xl/' + r[1].replace(/^\/?xl\//, '');
  }
  return out;
}

async function llenarPlantilla(buffer, filas) {
  const zip = await JSZip.loadAsync(buffer);
  const hojas = await rutasHojas(zip);
  if (!hojas[HOJA_DATOS]) throw new Error(`La plantilla no tiene la pestaña "${HOJA_DATOS}".`);

  // 1) "Sistema": se conserva la fila 1 y se reemplaza el resto
  let xml = await zip.file(hojas[HOJA_DATOS]).async('string');
  const ini = xml.indexOf('<sheetData'), fin = xml.indexOf('</sheetData>');
  const sheetData = xml.slice(ini, fin);
  const fila1 = (sheetData.match(/<row [^>]*r="1"[\s\S]*?<\/row>/) || [''])[0];
  const apertura = sheetData.match(/<sheetData[^>]*>/)[0];
  const nCols = Math.max(82, ...filas.map(f => f.length));
  const cuerpo = filas.map((f, i) => {
    const r = i + 2;
    return `<row r="${r}">${f.map((v, c) => celda(colLetra(c) + r, v)).join('')}</row>`;
  }).join('');
  xml = xml.slice(0, ini) + apertura + fila1 + cuerpo + xml.slice(fin);
  xml = xml.replace(/<dimension ref="[^"]*"\/>/, `<dimension ref="A1:${colLetra(nCols - 1)}${Math.max(1, filas.length + 1)}"/>`);
  zip.file(hojas[HOJA_DATOS], xml);

  // 2) "Para woocommerce": si hay más datos que filas con fórmulas, copiar la última hacia abajo
  let extendidas = 0;
  if (hojas[HOJA_FORMULAS]) {
    let fx = await zip.file(hojas[HOJA_FORMULAS]).async('string');
    const filasF = [...fx.matchAll(/<row [^>]*r="(\d+)"/g)].map(m => Number(m[1]));
    const ultima = Math.max(...filasF);
    const necesarias = filas.length + 1;
    if (necesarias > ultima) {
      const plantillaFila = fx.match(new RegExp(`<row [^>]*r="${ultima}"[\\s\\S]*?</row>`))[0];
      const re = new RegExp(`([A-Z]{1,3}\\$?)${ultima}(?![0-9])`, 'g');
      let nuevas = '';
      for (let r = ultima + 1; r <= necesarias; r++) {
        nuevas += plantillaFila.replace(new RegExp(`(<row [^>]*?)r="${ultima}"`), `$1r="${r}"`)
          .replace(re, (m, col) => col.endsWith('$') ? m : col + r)
          .replace(/<v>[^<]*<\/v>|<v\/>/g, '<v/>');
        extendidas++;
      }
      const cierre = fx.indexOf('</sheetData>');
      fx = fx.slice(0, cierre) + nuevas + fx.slice(cierre);
      fx = fx.replace(/(<dimension ref="[A-Z]+\d+:[A-Z]+)\d+("\/>)/, `$1${necesarias}$2`)
             .replace(/(<autoFilter ref="[A-Z]+\d+:[A-Z]+)\d+(")/, `$1${necesarias}$2`);
      zip.file(hojas[HOJA_FORMULAS], fx);
    }
    // Quitar las filas de fórmulas que sobran (más allá de los datos): así "Para woocommerce"
    // tiene exactamente una fila por cada fila de "Sistema".
    if (necesarias < ultima) {
      fx = await zip.file(hojas[HOJA_FORMULAS]).async('string');
      fx = fx.replace(/<row [^>]*r="(\d+)"[^>]*>[\s\S]*?<\/row>|<row [^>]*r="(\d+)"[^>]*\/>/g,
        (m, a, b) => Number(a || b) > necesarias ? '' : m);
      zip.file(hojas[HOJA_FORMULAS], fx);
    }
    if (necesarias !== ultima) {
      fx = await zip.file(hojas[HOJA_FORMULAS]).async('string');
      fx = fx.replace(/(<dimension ref="[A-Z]+\d+:[A-Z]+)\d+("\/>)/, `$1${necesarias}$2`)
             .replace(/(<autoFilter ref="[A-Z]+\d+:[A-Z]+)\d+(")/, `$1${necesarias}$2`);
      zip.file(hojas[HOJA_FORMULAS], fx);
      let wb = await zip.file('xl/workbook.xml').async('string');
      wb = wb.replace(/(<definedName name="_xlnm\._FilterDatabase"[^>]*>[^<]*!\$[A-Z]+\$\d+:\$[A-Z]+\$)\d+/, `$1${necesarias}`);
      zip.file('xl/workbook.xml', wb);
    }
  }

  // 2b) Borrar los resultados guardados de las fórmulas (eran de los datos viejos de la
  //     plantilla) para que Excel / Google Sheets / LibreOffice las calculen con los nuevos.
  //     Las fórmulas en sí no se tocan.
  if (hojas[HOJA_FORMULAS]) {
    let fx = await zip.file(hojas[HOJA_FORMULAS]).async('string');
    fx = fx.replace(/(<f>[^<]*<\/f>)(<v>[^<]*<\/v>|<v\/>)/g, '$1');
    zip.file(hojas[HOJA_FORMULAS], fx);
  }

  // 3) Recalcular todo al abrir y quitar la cadena de cálculo vieja
  let wb = await zip.file('xl/workbook.xml').async('string');
  wb = wb.replace(/<calcPr([^>]*?)\/>/, (m, a) => `<calcPr${a.replace(/\s*fullCalcOnLoad="[^"]*"/, '')} fullCalcOnLoad="1"/>`);
  zip.file('xl/workbook.xml', wb);
  if (zip.file('xl/calcChain.xml')) {
    zip.remove('xl/calcChain.xml');
    let rels = await zip.file('xl/_rels/workbook.xml.rels').async('string');
    rels = rels.replace(/<Relationship [^>]*Target="calcChain\.xml"[^>]*\/>/, '');
    zip.file('xl/_rels/workbook.xml.rels', rels);
    let ct = await zip.file('[Content_Types].xml').async('string');
    ct = ct.replace(/<Override [^>]*PartName="\/xl\/calcChain\.xml"[^>]*\/>/, '');
    zip.file('[Content_Types].xml', ct);
  }
  const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return { buffer: out, extendidas };
}

module.exports = { PLANTILLA, filaSistema, atributos, llenarPlantilla, decimal, nl, colLetra };
