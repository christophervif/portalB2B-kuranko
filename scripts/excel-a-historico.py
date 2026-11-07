#!/usr/bin/env python3
"""
Excel histórico (INVENTARIO KURANKO PARA EL SISTEMA DE VENTAS.xlsm) → historico-excel.json

Uso:  python3 scripts/excel-a-historico.py "INVENTARIO KURANKO ... .xlsm" [salida.json]
Luego se carga en el panel: Ventas e ingresos → "Histórico del Excel" → Cargar archivo…

El JSON trae:
  filas      totales por día y empresa (ventas, N° ventas, cobrado, margen, compras)
  lineas     cada línea de venta (producto, marca, cantidad, venta y costo con/sin IGV,
             forma de pago, empresa del cobro, cliente empresa o persona)
  compras    cada línea de compra (producto, marca, cantidad, costo con IGV)

Reglas de empresa (1 = Diseños Corporativos SAC, 2 = Christopher Villasante F.):
  venta  : Magura / Mondraker / Fidlock → 1; si no, la cuenta de la forma de pago
           (…DISEÑOS → 1, …KURANKO → 2); si no hay, por IGV: PrecioUnit ≠ PrecioUnit
           sin IGV → 1, iguales → 2.
  cobro  : siempre la cuenta de la forma de pago. Sin forma de pago no es cobro.
  compra : Magura / Mondraker / Fidlock → 1; importador DISEÑOS CORPORATIVOS SAC → 1;
           el resto (Christopher y familia) → 2.
Marca: columna "Marcas" de la hoja Productos (por código); si falta, primera palabra.
"""
import sys, json, datetime, collections
import openpyxl

MARCAS_DISENOS = {'MAGURA', 'MONDRAKER', 'FIDLOCK'}
num = lambda v: float(v) if isinstance(v, (int, float)) else 0.0

def empresa_cuenta(pago):
    p = str(pago or '').upper()
    if 'DISEÑOS' in p or 'DISENOS' in p: return 1
    if 'KURANKO' in p: return 2
    return 0

def main(origen, destino):
    wb = openpyxl.load_workbook(origen, read_only=True, data_only=True)
    # Productos: código → marca (encabezado en la fila 8)
    marca_de = {}
    for r in wb['Productos'].iter_rows(values_only=True, min_row=9):
        if len(r) > 8 and r[2] and r[8]: marca_de[str(r[2]).strip()] = str(r[8]).strip()
    def marca(cod, nombre):
        m = marca_de.get(str(cod or '').strip())
        return m or (str(nombre or '').split(' ')[0] if nombre else '')

    # ── Salidas (encabezado en la fila 7) ──
    lineas, ventas_dia = [], collections.defaultdict(set)
    for r in wb['Salidas'].iter_rows(values_only=True, min_row=8):
        f = r[2]
        if not isinstance(f, datetime.datetime): continue
        fecha = f.date().isoformat()
        cod, nom = r[3], r[4]
        mar = marca(cod, nom)
        cant = num(r[7]); venta = num(r[8]); pu, pu_sin = num(r[6]), num(r[9])
        venta_neta = pu_sin * cant if pu_sin else venta
        costo_sin, costo_con = num(r[23]), num(r[24]) or num(r[23])
        pago = r[28] if len(r) > 28 else None
        if mar.upper() in MARCAS_DISENOS: cid = 1
        elif empresa_cuenta(pago): cid = empresa_cuenta(pago)
        else: cid = 1 if abs(pu - pu_sin) > 0.005 else 2
        doc = str(r[15] or '').strip()
        b2b = 1 if len(doc) == 11 and doc[:2] in ('10', '20') else 0
        lineas.append([fecha, cid, str(cod or ''), str(nom or '')[:150], mar, cant, round(venta, 2), round(venta_neta, 2),
                       round(costo_con, 2), round(costo_sin, 2), str(pago or ''), empresa_cuenta(pago), b2b, str(r[13] or '')[:60]])
        ventas_dia[(fecha, cid)].add(str(r[13] or '').strip().upper() or ('#' + str(r[1])))
    # ── Entradas (encabezado en la fila 2) ──
    compras = []
    for r in wb['Entradas'].iter_rows(values_only=True, min_row=3):
        f = r[10]
        if not isinstance(f, datetime.datetime) or str(r[0] or '').lower() == 'no': continue
        mar = marca(r[11], r[12])
        imp = str(r[1] or '').upper()
        cid = 1 if mar.upper() in MARCAS_DISENOS or 'DISEÑOS' in imp or 'DISENOS' in imp else 2
        costo = num(r[21])
        if not costo: continue
        compras.append([f.date().isoformat(), cid, str(r[11] or ''), str(r[12] or '')[:150], mar, num(r[17]), round(costo, 2)])
    # ── Totales por día y empresa (los mismos números que las líneas) ──
    acc = collections.defaultdict(lambda: dict(ventas=0, num_ventas=0, ingresos=0, margen=0, base_margen=0, ingreso_items=0, compras=0))
    for l in lineas:
        a = acc[(l[0], l[1])]
        a['ventas'] += l[6]; a['ingreso_items'] += l[6]
        if l[8] > 0: a['base_margen'] += l[6]; a['margen'] += l[6] - l[8]
        if l[11]: acc[(l[0], l[11])]['ingresos'] += l[6]
    for (f, c), s in ventas_dia.items(): acc[(f, c)]['num_ventas'] = len(s)
    for c in compras: acc[(c[0], c[1])]['compras'] += c[6]
    cols = ['fecha', 'company_id', 'ventas', 'num_ventas', 'ingresos', 'margen', 'base_margen', 'ingreso_items', 'compras']
    filas = [[f, c] + [round(acc[(f, c)][k], 2) for k in cols[2:]] for (f, c) in sorted(acc)]
    out = {'origen': origen.split('/')[-1][:120], 'generado': datetime.datetime.now().isoformat(timespec='seconds'),
           'columnas': cols, 'filas': filas,
           'lineas': {'columnas': ['fecha', 'company_id', 'codigo', 'producto', 'marca', 'cantidad', 'venta', 'venta_neta',
                                   'costo', 'costo_neto', 'pago', 'emp_cobro', 'b2b', 'cliente'], 'filas': lineas},
           'compras': {'columnas': ['fecha', 'company_id', 'codigo', 'producto', 'marca', 'cantidad', 'costo'], 'filas': compras}}
    json.dump(out, open(destino, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    print(f'{len(filas)} días-empresa · {len(lineas)} líneas de venta · {len(compras)} líneas de compra → {destino}')

if __name__ == '__main__':
    if len(sys.argv) < 2: sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else 'historico-excel.json')
