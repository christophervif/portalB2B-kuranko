// ═══════════════════════════════════════════════════════════════════════════
//  Lista de productos en promoción (compartida por el portal de clientes y el
//  link libre de vendedores). Se usa así:
//    OfertasLista.montar(contenedor, { modo: 'portal'|'link', datos, enviar: async (items, nota) => respuesta })
//  · Tabla compacta (entra en el ancho normal de la página, sin estirarla): el SKU va
//    debajo del nombre y los encabezados pueden partirse en dos líneas.
//  · Tocar la foto la abre en grande con los mismos datos (protegida si está proteger.js).
//  · Pie como el del catálogo: resumen 🛒, nota opcional, Vaciar y Enviar solicitud.
//  · modo 'portal' muestra "Precio taller oferta"; modo 'link' NO (el servidor ni lo manda).
//  · datos = respuesta de /portal/promociones o /api/oferta/:token
//  · enviar(items) debe devolver { numero, reservado_hasta, whatsapp, correo_enviado } (lo arma el servidor)
//  · solicitudes() (opcional) devuelve { solicitudes: [...] } para mostrar "Mis solicitudes" y su estado
//  · recargar() (opcional) vuelve a traer los datos tras enviar (el stock reservado deja de estar disponible)
//  Usa las variables de color de la página (--surface, --border, --accent, …).
// ═══════════════════════════════════════════════════════════════════════════
(function () {
  const CSS = `
  .ol{font-size:13px;color:var(--text)}
  .ol-aviso{background:var(--surface2,var(--surface));border:1px solid var(--border);border-radius:12px;padding:10px 12px;margin:8px 0 12px;color:var(--text2,var(--text));line-height:1.5}
  .ol-barra{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px}
  .ol-barra input,.ol-barra select{background:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:10px;padding:8px 10px;font-size:13px}
  .ol-barra input[type=search]{flex:1;min-width:180px}
  .ol h4{font-size:14px;margin:18px 0 6px;color:var(--white,var(--text))}
  .ol-wrap{overflow:auto;border:1px solid var(--border);border-radius:12px}
  .ol table{width:100%;border-collapse:collapse}
  .ol th{position:sticky;top:0;background:var(--surface3,var(--surface));text-align:left;padding:7px 6px;font-size:10.5px;line-height:1.25;color:var(--muted2,var(--muted));font-weight:600;border-bottom:1px solid var(--border);cursor:pointer;user-select:none;z-index:1}
  .ol th.n,.ol td.n{text-align:right}
  .ol th.asc::after{content:' ↑';color:var(--accent)}.ol th.desc::after{content:' ↓';color:var(--accent)}
  .ol td{padding:7px 6px;border-bottom:1px solid var(--border);vertical-align:middle}
  .ol tr.sel td{background:var(--hover)}
  .ol img.ol-img{width:46px;height:46px;object-fit:contain;border-radius:8px;background:#fff;display:block;cursor:zoom-in}
  .ol .ol-sinimg{width:46px;height:46px;border-radius:8px;background:var(--surface3,var(--border));display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:18px}
  .ol .ol-nom{font-weight:600;line-height:1.3;min-width:140px}
  .ol .ol-sku{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--muted)}
  .ol .ol-sub{font-size:11px;color:var(--muted);margin-top:2px;white-space:nowrap}
  .ol .ol-pvp{text-decoration:line-through;color:var(--muted)}
  .ol .ol-of{font-weight:700;font-size:13.5px;color:var(--white,var(--text))}
  .ol .ol-tu{font-weight:700;font-size:13.5px;color:var(--accent)}
  .ol .ol-chip{display:inline-block;font-size:10.5px;font-weight:700;padding:2px 7px;border-radius:20px;background:var(--bg-ok);color:var(--fg-ok)}
  .ol .ol-chip.w{background:var(--bg-warn);color:var(--fg-warn)}
  .ol input.ol-q{width:56px;background:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:6px;text-align:right}
  .ol .ol-stock{position:relative;display:inline-block;cursor:help;border-bottom:1px dotted var(--muted);font-weight:700}
  .ol .ol-tip{display:none;position:absolute;right:0;top:100%;margin-top:4px;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:8px 10px;box-shadow:0 6px 20px rgba(0,0,0,.25);z-index:5;white-space:nowrap;text-align:left;font-weight:400;font-size:12px;color:var(--text)}
  .ol .ol-stock:hover .ol-tip,.ol .ol-stock.abierto .ol-tip{display:block}
  .ol .ol-liq{border:1px solid var(--fg-warn);background:var(--bg-warn);color:var(--fg-warn);border-radius:12px;padding:10px 12px;margin:6px 0 10px;line-height:1.5}
  .ol-pie{position:sticky;bottom:0;margin-top:12px;background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:10px 12px;display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap;box-shadow:0 -4px 16px rgba(0,0,0,.15);z-index:3}
  .ol-pie .ol-btn{background:var(--accent);color:var(--accent-text);border:none;border-radius:10px;padding:10px 16px;font-weight:700;cursor:pointer;font-size:14px}
  .ol-pie .ol-btn:disabled{opacity:.5;cursor:default}
  .ol-pie .ol-acc{display:flex;gap:8px;flex-wrap:wrap;flex:1;justify-content:flex-end;align-items:center}
  .ol-pie input.ol-nota{flex:1;min-width:160px;background:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:10px;padding:9px 10px;font-size:13px}
  .ol-pie .ol-sec{background:var(--surface3,var(--surface));border:1px solid var(--border);color:var(--text2,var(--text));border-radius:10px;padding:9px 12px;cursor:pointer;font-weight:600}
  .ol-pie.vacio{display:none}
  .ol-zoom{position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:300;display:none;align-items:center;justify-content:center;padding:16px}
  .ol-zoom.on{display:flex}
  .ol-zoom .ol-zbox{background:var(--surface);color:var(--text);border-radius:14px;max-width:min(720px,100%);width:100%;padding:14px;position:relative;font-size:13px;line-height:1.5}
  .ol-zoom .ol-zimg{background:#fff;border-radius:10px;display:flex;align-items:center;justify-content:center;height:min(60vh,520px)}
  .ol-zoom .ol-zimg img{max-width:100%;max-height:100%;object-fit:contain}
  .ol-zoom .ol-zx{position:absolute;top:6px;right:10px;background:none;border:none;color:var(--muted);font-size:26px;cursor:pointer;z-index:6}
  .ol-ok{border:1px solid var(--fg-ok);background:var(--bg-ok);color:var(--fg-ok);border-radius:12px;padding:12px;margin-top:12px;line-height:1.6}
  .ol-ok a{color:inherit;font-weight:700}
  .ol-vacio{color:var(--muted);text-align:center;padding:24px}
  .ol-vivo{display:inline-flex;align-items:center;gap:8px;font-size:12.5px;color:var(--text2,var(--text));margin-bottom:6px}
  .ol-vivo::before{content:'';width:8px;height:8px;border-radius:50%;background:var(--fg-ok);box-shadow:0 0 0 3px var(--bg-ok);animation:olpulso 2s infinite}
  @keyframes olpulso{50%{opacity:.4}}
  .ol-sol{border:1px solid var(--border);border-radius:12px;padding:10px 12px;margin-bottom:8px;background:var(--surface2,var(--surface))}
  .ol-sol .ol-e{display:inline-block;font-size:10.5px;font-weight:700;padding:2px 7px;border-radius:20px;margin-left:4px}
  .ol-e.pendiente{background:var(--bg-warn);color:var(--fg-warn)}.ol-e.concretada{background:var(--bg-ok);color:var(--fg-ok)}
  .ol-e.parcial{background:var(--bg-warn);color:var(--fg-warn)}.ol-e.vencida,.ol-e.cancelada{background:var(--surface3,var(--border));color:var(--muted)}
  .ol td.n{white-space:nowrap}
  /* Celular: cada producto como tarjeta (sin desplazamiento horizontal) */
  @media(max-width:900px){
    .ol-wrap{overflow:visible;border:none}
    .ol table,.ol tbody,.ol tr,.ol td{display:block;width:100%}
    .ol thead{display:none}
    .ol tr{display:grid;grid-template-columns:28px 48px 1fr;column-gap:10px;border:1px solid var(--border);border-radius:12px;padding:10px;margin-bottom:10px;background:var(--surface)}
    .ol td{border:none;padding:2px 0}
    .ol td.ol-c-sel{grid-row:1/3;padding-top:14px}.ol td.ol-c-img{grid-row:1/3}
    .ol td.ol-c-nom{grid-column:3}
    .ol td[data-l]{grid-column:1/4;display:flex;justify-content:space-between;align-items:center;gap:8px;text-align:right;border-top:1px dashed var(--border);padding:6px 0}
    .ol td[data-l]::before{content:attr(data-l);font-size:11px;color:var(--muted);text-align:left;white-space:nowrap}
    .ol td[data-l] .ol-sub{white-space:normal}
    .ol img.ol-img,.ol .ol-sinimg{width:44px;height:44px}.ol .ol-nom{min-width:0}
    .ol .ol-tip{right:auto;left:0}
    .ol td.ol-vacio{grid-column:1/4}
  }`;

  const esc = t => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const S = n => n == null ? '—' : 'S/ ' + Number(n).toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fecha = d => d ? new Date(d).toLocaleDateString('es-PE', { timeZone: 'America/Lima', day: 'numeric', month: 'long' }) : '';

  function montar(el, cfg) {
    if (!document.getElementById('ol-css')) { const st = document.createElement('style'); st.id = 'ol-css'; st.textContent = CSS; document.head.appendChild(st); }
    const portal = cfg.modo === 'portal';
    const items = (cfg.datos.items || []).map((x, i) => ({ ...x, _orden: i }));
    const cant = {};                       // vid → cantidad elegida
    let orden = { k: null, dir: 'asc' }, filtro = '', marca = '';
    const marcas = [...new Set(items.map(x => x.marca))].sort();
    const hasta = [...new Set(items.map(x => fecha(x.hasta)))];

    el.innerHTML = `<div class="ol">
      <div class="ol-vivo" data-zona="vivo" style="display:none"></div>
      <div class="ol-aviso">${portal
        ? `Precios de promoción para ${cfg.datos.tipo_cuenta === 'mecanico' ? 'tu taller' : 'tu tienda'}. <b>Precio taller oferta</b> es lo que pagas; <b>PVP oferta</b> es el precio de venta al público recomendado. Al enviar la solicitud, las unidades quedan <b>reservadas</b> para ti por un tiempo limitado.`
        : `Precios de promoción para el público. <b>PVP oferta</b> es el precio de venta recomendado durante la campaña.`}
        El <b>stock en oferta</b> es lo que queda del lote en promoción; pasa el mouse (o toca) para ver el stock total por ubicación.
        ${hasta.length === 1 ? `Válido hasta el <b>${esc(hasta[0])}</b> o hasta agotar el stock en oferta.` : 'Válido hasta agotar el stock en oferta.'}</div>
      <div class="ol-barra">
        <input type="search" placeholder="Buscar por nombre o SKU…" data-f="q">
        ${marcas.length > 1 ? `<select data-f="marca"><option value="">Todas las marcas</option>${marcas.map(m => `<option>${esc(m)}</option>`).join('')}</select>` : ''}
      </div>
      <div data-zona="ofertas"></div>
      <div data-zona="liq"></div>
      <div class="ol-pie vacio"><div data-zona="resumen"></div>
        <div class="ol-acc"><input class="ol-nota" data-f="nota" maxlength="1000" placeholder="Nota para Kuranko (opcional)">
          <button class="ol-sec" data-acc="vaciar">Vaciar</button><button class="ol-btn" data-acc="enviar" disabled>Enviar solicitud</button></div></div>
      <div class="ol-zoom" data-zona="zoom"><div class="ol-zbox"><button class="ol-zx" data-acc="zcerrar">×</button><div class="ol-zimg"><img alt="" draggable="false"></div><div data-zona="zinfo" style="margin-top:10px"></div></div></div>
      <div data-zona="ok"></div>
      <div data-zona="sol"></div>
    </div>`;
    const $ = s => el.querySelector(s);

    const cols = () => [
      { k: 'sel', t: '' }, { k: 'img', t: '' }, { k: 'nombre', t: 'Producto' },
      ...(portal ? [{ k: 'tu_precio', t: 'Precio taller oferta', n: 1 }] : []),
      { k: 'stock_oferta', t: 'Stock oferta', n: 1 }, { k: 'precio', t: 'PVP oferta', n: 1 }, { k: 'pvp', t: 'PVP', n: 1 }, { k: 'q', t: 'Cantidad', n: 1 }
    ];
    function filas(lista) {
      let r = lista.filter(x => (!marca || x.marca === marca) && (!filtro || (x.sku + ' ' + x.nombre).toLowerCase().includes(filtro)));
      if (orden.k && !['sel', 'img', 'q'].includes(orden.k)) {
        const m = orden.dir === 'asc' ? 1 : -1, k = orden.k;
        r = r.slice().sort((a, b) => (typeof a[k] === 'string' ? String(a[k]).localeCompare(b[k]) : (a[k] ?? -1) - (b[k] ?? -1)) * m);
      } else r = r.slice().sort((a, b) => a._orden - b._orden);
      return r;
    }
    function tabla(lista, vacio) {
      const c = cols();
      const head = '<thead><tr>' + c.map(x => `<th class="${[x.n ? 'n' : '', orden.k === x.k ? orden.dir : ''].join(' ').trim()}" data-ord="${x.k}">${x.t}</th>`).join('') + '</tr></thead>';
      if (!lista.length) return `<div class="ol-wrap"><table>${head}<tbody><tr><td colspan="${c.length}" class="ol-vacio">${vacio}</td></tr></tbody></table></div>`;
      return `<div class="ol-wrap"><table>${head}<tbody>${lista.map(x => {
        const q = cant[x.vid] || 0;
        const tip = `<span class="ol-tip"><b>Stock disponible</b><br>${(x.ciudades || []).map(c => `${c.unidades} ${esc(c.ciudad)}`).join('<br>') || '—'}<br><span style="color:var(--muted)">Total: ${x.stock_total}</span></span>`;
        let luego = '';
        const pAhora = portal ? x.tu_precio : x.precio;
        if (x.siguiente) {
          if (x.siguiente.sale) luego = `<div class="ol-sub">Luego de estas ${x.stock_oferta} und: vuelve al precio normal</div>`;
          else {
            const pLuego = portal ? x.siguiente.tu_precio : x.siguiente.precio;
            // Solo se avisa si el precio SUBE (urgencia: "aprovecha"). Si luego baja no se muestra:
            // nadie esperaría a que se acabe el lote y quien compra hoy no ve su compra desvalorizada.
            if (pLuego - pAhora >= 0.01) luego = `<div class="ol-sub" title="Cuando se acaben las ${x.stock_oferta} und en oferta">Luego sube a ${S(pLuego)}</div>`;
          }
        }
        return `<tr class="${q ? 'sel' : ''}">
          <td class="ol-c-sel"><input type="checkbox" data-sel="${x.vid}" ${q ? 'checked' : ''} ${x.stock_oferta ? '' : 'disabled'}></td>
          <td class="ol-c-img">${x.imagen ? `<img class="ol-img" loading="lazy" src="${esc(x.imagen)}" alt="" draggable="false" data-zoom="${x.vid}">` : '<div class="ol-sinimg">🚲</div>'}</td>
          <td class="ol-c-nom"><div class="ol-nom">${esc(x.nombre)}</div><div class="ol-sku">${esc(x.sku)}${x.marca ? ' · ' + esc(x.marca) : ''}</div>${x.cambios_lote ? '<div class="ol-sub">Nuevo lote en oferta</div>' : ''}</td>
          ${portal ? `<td class="n" data-l="Precio taller oferta"><span><span class="ol-tu">${S(x.tu_precio)}</span>${luego}</span></td>` : ''}
          <td class="n" data-l="Stock en oferta"><span class="ol-stock" tabindex="0">${x.stock_oferta}${tip}</span>${x.reservado ? `<div class="ol-sub">${x.stock_oferta ? '+' + x.reservado + ' reservadas' : 'Reservado por otra tienda'}</div>` : ''}</td>
          <td class="n" data-l="PVP oferta"><span><span class="ol-of">${S(x.precio)}</span> <span class="ol-chip${x.liquidacion ? ' w' : ''}">−${Math.round(x.desc_pct)}%</span>${portal ? '' : luego}</span></td>
          <td class="n" data-l="PVP"><span class="ol-pvp">${S(x.pvp)}</span></td>
          <td class="n" data-l="Cantidad"><input class="ol-q" type="number" min="0" max="${x.stock_oferta}" step="1" value="${q || ''}" placeholder="0" data-q="${x.vid}" ${x.stock_oferta ? '' : 'disabled'}></td>
        </tr>`;
      }).join('')}</tbody></table></div>`;
    }
    function pintar() {
      const of = filas(items.filter(x => !x.liquidacion)), lq = filas(items.filter(x => x.liquidacion));
      $('[data-zona=ofertas]').innerHTML = `<h4>Ofertas</h4>` + tabla(of, 'No hay productos en oferta con ese filtro.');
      $('[data-zona=liq]').innerHTML = items.some(x => x.liquidacion) ? `<h4>Liquidación</h4>
        <div class="ol-liq">${portal
          ? `<b>Precio de liquidación:</b> estos productos se ofrecen a precio de costo. Por eso el precio taller oferta es igual al PVP oferta: no dejan margen de reventa. Son ideales para cerrar una venta o para tu propio uso.`
          : `<b>Precio de liquidación:</b> estos productos se ofrecen a precio de costo, el mismo al que la tienda los compra, así que <b>no dejan margen para la tienda</b>. Ofrécelos cuando el cliente busque el mejor precio o para cerrar una venta.`}</div>`
        + tabla(lq, 'No hay productos en liquidación con ese filtro.') : '';
      resumen();
    }
    function elegidos() { return items.filter(x => cant[x.vid] > 0).map(x => ({ ...x, cantidad: cant[x.vid] })); }
    function resumen() {
      const e = elegidos();
      const und = e.reduce((a, x) => a + x.cantidad, 0);
      const tot = e.reduce((a, x) => a + x.cantidad * (portal ? x.tu_precio : x.precio), 0);
      $('[data-zona=resumen]').innerHTML = e.length ? `🛒 <b>${e.length}</b> producto${e.length > 1 ? 's' : ''} · ${und} und · <b>${S(tot)}</b> <span style="color:var(--muted);font-size:11px">${portal ? 'a precio taller' : 'a PVP oferta'}</span>` : '';
      $('.ol-pie').classList.toggle('vacio', !e.length);
      $('[data-acc=enviar]').disabled = !e.length;
    }

    el.addEventListener('input', ev => {
      const t = ev.target;
      if (t.dataset.f === 'q') { filtro = t.value.toLowerCase().trim(); pintar(); }
      if (t.dataset.q) {
        const x = items.find(i => i.vid === Number(t.dataset.q)); let q = Math.floor(Number(t.value) || 0);
        if (q > x.stock_oferta) { q = x.stock_oferta; t.value = q; }
        cant[x.vid] = Math.max(0, q);
        const tr = t.closest('tr'); tr.classList.toggle('sel', q > 0); tr.querySelector('[data-sel]').checked = q > 0;
        resumen();
      }
    });
    el.addEventListener('change', ev => {
      const t = ev.target;
      if (t.dataset.f === 'marca') { marca = t.value; pintar(); }
      if (t.dataset.sel) { const vid = Number(t.dataset.sel); cant[vid] = t.checked ? (cant[vid] || 1) : 0; pintar(); }
    });
    el.addEventListener('click', ev => {
      const th = ev.target.closest('th[data-ord]');
      if (th && !['sel', 'img', 'q'].includes(th.dataset.ord)) {
        const k = th.dataset.ord;
        orden = orden.k === k ? { k, dir: orden.dir === 'asc' ? 'desc' : 'asc' } : { k, dir: ['sku', 'nombre'].includes(k) ? 'asc' : 'desc' };
        pintar(); return;
      }
      const st = ev.target.closest('.ol-stock');
      el.querySelectorAll('.ol-stock.abierto').forEach(x => { if (x !== st) x.classList.remove('abierto'); });
      if (st) st.classList.toggle('abierto');
      if (ev.target.closest('[data-acc=enviar]')) enviar();
      if (ev.target.closest('[data-acc=vaciar]')) { Object.keys(cant).forEach(k => delete cant[k]); pintar(); }
      const zi = ev.target.closest('[data-zoom]');
      if (zi) zoom(Number(zi.dataset.zoom));
      if (ev.target.closest('[data-acc=zcerrar]') || ev.target === $('[data-zona=zoom]')) $('[data-zona=zoom]').classList.remove('on');
    });
    document.addEventListener('keydown', ev => { if (ev.key === 'Escape') $('[data-zona=zoom]').classList.remove('on'); });
    // Foto en grande con los mismos datos de la fila
    let zoomProtegido = false;
    function zoom(vid) {
      const x = items.find(i => i.vid === vid); if (!x || !x.imagen) return;
      const z = $('[data-zona=zoom]');
      if (!zoomProtegido && window.Proteger) { Proteger.activar(z.querySelector('.ol-zbox')); zoomProtegido = true; }
      z.querySelector('.ol-zimg img').src = x.imagen;
      $('[data-zona=zinfo]').innerHTML = `<b style="font-size:14px">${esc(x.nombre)}</b><br><span style="color:var(--muted)">SKU ${esc(x.sku)}${x.marca ? ' · ' + esc(x.marca) : ''}</span><br>
        ${portal ? `Precio taller oferta <b style="color:var(--accent)">${S(x.tu_precio)}</b> · ` : ''}PVP oferta <b>${S(x.precio)}</b> <span class="ol-chip${x.liquidacion ? ' w' : ''}">−${Math.round(x.desc_pct)}%</span> · PVP <span class="ol-pvp">${S(x.pvp)}</span>
        <br><span style="color:var(--muted)">Stock en oferta: ${x.stock_oferta}${x.stock_total != null ? ' · stock total ' + x.stock_total : ''}${x.liquidacion ? ' · liquidación' : ''}</span>`;
      z.classList.add('on');
    }

    async function enviar() {
      const e = elegidos(); if (!e.length) return;
      const btn = $('[data-acc=enviar]');
      if (cfg.antesDeEnviar && !(await cfg.antesDeEnviar())) return;
      // Se abre la pestaña de WhatsApp ya (si se abre después de esperar al servidor, el navegador la bloquea)
      const w = window.open('', '_blank');
      btn.disabled = true; btn.textContent = 'Enviando…';
      try {
        const r = await cfg.enviar(e.map(x => ({ vid: x.vid, sku: x.sku, cantidad: x.cantidad })), ($('[data-f=nota]').value || '').trim());
        if (w) { try { w.location.href = r.whatsapp; } catch (er) {} }
        const hasta = r.reservado_hasta ? new Date(r.reservado_hasta).toLocaleString('es-PE', { timeZone: 'America/Lima', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) : '';
        $('[data-zona=ok]').innerHTML = `<div class="ol-ok">✓ Solicitud N° <b>${esc(r.numero)}</b> enviada${r.correo_enviado ? ' por correo al equipo de ventas' : ''}.
          ${hasta ? `<br>Las unidades quedan <b>reservadas hasta el ${esc(hasta)}</b>. Se concreta cuando registramos la venta a tu RUC.` : ''}
          <br>Si no se abrió WhatsApp, <a href="${esc(r.whatsapp)}" target="_blank" rel="noopener">toca aquí para enviarla por WhatsApp</a>.</div>`;
        Object.keys(cant).forEach(k => delete cant[k]);
        $('[data-f=nota]').value = '';
        if (cfg.recargar) { try { const d = await cfg.recargar(); const nuevo = new Map((d.items || []).map(i => [i.vid, i])); items.forEach(x => { const n = nuevo.get(x.vid); if (n) Object.assign(x, { stock_oferta: n.stock_oferta, reservado: n.reservado }); else x.stock_oferta = 0; }); } catch (er) {} }
        pintar(); pintarSol();
        $('[data-zona=ok]').scrollIntoView({ behavior: 'smooth', block: 'center' });
      } catch (er) {
        if (w) w.close();
        $('[data-zona=ok]').innerHTML = `<div class="ol-liq">⚠ ${esc(er.message)}</div>`;
      } finally { btn.textContent = 'Enviar solicitud'; resumen(); }
    }
    const NOM_E = { pendiente: 'reservado', concretada: 'concretada', parcial: 'parcial', vencida: 'vencida', cancelada: 'cancelada' };
    async function pintarSol() {
      if (!cfg.solicitudes) return;
      let d; try { d = await cfg.solicitudes(); } catch (e) { return; }
      const l = d.solicitudes || [];
      $('[data-zona=sol]').innerHTML = !l.length ? '' : `<h4>Mis solicitudes</h4>` + l.map(g => `<div class="ol-sol">
        <b>N° ${esc(g.numero)}</b> · ${new Date(g.fecha).toLocaleString('es-PE', { timeZone: 'America/Lima', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}${g.vendedor ? ' · ' + esc(g.vendedor) : ''}
        ${g.items.map(i => `<div class="ol-sub" style="white-space:normal;font-size:12px;margin-top:4px">${esc(i.sku)} · ${esc(i.nombre)} × ${i.cantidad}
          <span class="ol-e ${i.estado}">${NOM_E[i.estado] || i.estado}${i.estado === 'parcial' ? ` ${i.vendidas}/${i.cantidad}` : ''}</span>
          ${i.estado === 'pendiente' ? ` hasta ${new Date(i.vence_en).toLocaleString('es-PE', { timeZone: 'America/Lima', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}
          ${i.ventas ? ` · venta ${esc(i.ventas)}` : ''}</div>`).join('')}</div>`).join('');
    }
    // Personas viendo promociones ahora (portal + links de todas las tiendas); se oculta si es solo uno
    function setViendo(n) {
      const z = $('[data-zona=vivo]'); n = Number(n) || 0;
      z.style.display = n >= 2 ? '' : 'none';
      z.textContent = `${n} personas viendo promociones ahora`;
    }
    pintar(); pintarSol(); setViendo(cfg.datos.viendo);
    return { setViendo };
  }
  window.OfertasLista = { montar };
})();
