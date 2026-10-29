// ═══════════════════════════════════════════════════════════════════════════
//  Protección de listas de precios (catálogo B2B y promociones) en el portal.
//  Dificulta sacar la lista fuera del portal:
//   · No se imprime: al imprimir (Ctrl+P o menú) la zona sale oculta con un aviso.
//   · No se copia ni se selecciona el texto; sin menú del clic derecho ni arrastrar.
//   · Bloquea Ctrl/Cmd + P, S, C, A, U mientras la zona está a la vista.
//   · Marca de agua con el nombre y el RUC del cliente y la fecha: si alguien pasa
//     una captura de pantalla, se sabe de qué cuenta salió.
//  Ojo: ninguna web puede impedir del todo una captura de pantalla o una foto al
//  monitor; esto disuade y deja rastro.
//
//  Uso:  Proteger.activar(elemento)          → protege esa zona
//        Proteger.marca('Tienda X · RUC …')  → texto de la marca de agua
// ═══════════════════════════════════════════════════════════════════════════
(function () {
  var zonas = [], texto = '';
  var css = '.prot-zona{position:relative;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}' +
    '.prot-zona input,.prot-zona textarea,.prot-zona select{-webkit-user-select:text;user-select:text}' +
    '.prot-marca{position:absolute;inset:0;pointer-events:none;z-index:4;background-repeat:repeat;opacity:.09;border-radius:inherit}' +
    '.prot-aviso{display:none}' +
    '@media print{.prot-zona{display:none!important}.prot-aviso{display:block!important;padding:24px;font:14px Arial,sans-serif;color:#333}}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  function fondo() {
    if (!texto) return 'none';
    var t = String(texto).replace(/[<>&"]/g, function (c) { return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]; });
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="170"><text x="0" y="110" transform="rotate(-22 180 85)" ' +
      'font-family="Arial,sans-serif" font-size="15" font-weight="700" fill="#888">' + t + '</text></svg>';
    return 'url("data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg) + '")';
  }
  function pintarMarcas() { zonas.forEach(function (z) { z.marca.style.backgroundImage = fondo(); }); }
  var visible = function (el) { return !!(el.offsetParent || el.getClientRects().length); };
  var esCampo = function (el) { return el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName); };
  function dentro(ev) { return zonas.some(function (z) { return z.el.contains(ev.target); }); }
  function algunaVisible() { return zonas.some(function (z) { return visible(z.el); }); }

  ['copy', 'cut', 'contextmenu', 'dragstart'].forEach(function (tipo) {
    document.addEventListener(tipo, function (ev) {
      if (dentro(ev) && !(tipo !== 'contextmenu' && esCampo(ev.target))) ev.preventDefault();
    }, true);
  });
  document.addEventListener('selectstart', function (ev) { if (dentro(ev) && !esCampo(ev.target)) ev.preventDefault(); }, true);
  document.addEventListener('keydown', function (ev) {
    if (!(ev.ctrlKey || ev.metaKey) || !algunaVisible()) return;
    var k = String(ev.key || '').toLowerCase();
    if (k === 'p' || k === 's' || k === 'u') { ev.preventDefault(); ev.stopPropagation(); }
    else if ((k === 'c' || k === 'a') && !esCampo(document.activeElement)) { ev.preventDefault(); ev.stopPropagation(); }
  }, true);
  // Tecla Imprimir pantalla: se intenta vaciar el portapapeles (funciona en algunos navegadores)
  document.addEventListener('keyup', function (ev) {
    if (ev.key === 'PrintScreen' && algunaVisible()) { try { navigator.clipboard.writeText(''); } catch (e) {} }
  });

  window.Proteger = {
    activar: function (el) {
      if (!el || zonas.some(function (z) { return z.el === el; })) return;
      el.classList.add('prot-zona');
      var m = document.createElement('div'); m.className = 'prot-marca'; m.setAttribute('aria-hidden', 'true');
      el.appendChild(m);
      var aviso = document.createElement('div'); aviso.className = 'prot-aviso';
      aviso.textContent = 'Esta lista de precios no está disponible para imprimir ni exportar. Consúltala en el Portal Kuranko.';
      el.parentNode.insertBefore(aviso, el.nextSibling);
      zonas.push({ el: el, marca: m });
      pintarMarcas();
    },
    marca: function (t) { texto = t || ''; pintarMarcas(); }
  };
})();
