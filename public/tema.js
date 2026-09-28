// ═══════════════════════════════════════════════════════════════════════════
//  Tema compartido (claro / oscuro) para las mini-apps que se abren en iframe
//  dentro del panel admin (cotizador, cuentas por cobrar, créditos, seguimiento,
//  importaciones). Se carga en el <head> para que la página no "parpadee".
//   1) Al abrir: usa el tema guardado por el panel principal (localStorage
//      'tema_admin'); si no hay, el del sistema operativo.
//   2) En vivo: cuando el panel cambia el tema, avisa a sus iframes
//      (postMessage) y la página lo aplica al instante. También escucha el
//      evento 'storage' (cambios hechos desde otra pestaña del navegador).
// ═══════════════════════════════════════════════════════════════════════════
(function () {
  var raiz = document.documentElement;
  function aplicar(t) { if (t === 'light' || t === 'dark') raiz.setAttribute('data-theme', t); }
  try {
    var guardado = localStorage.getItem('tema_admin');
    if (guardado) aplicar(guardado);
    else aplicar(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  } catch (e) { aplicar('dark'); }
  window.addEventListener('message', function (e) {
    if (e.origin === location.origin && e.data && e.data.tipo === 'tema') aplicar(e.data.tema);
  });
  window.addEventListener('storage', function (e) {
    if (e.key === 'tema_admin') aplicar(e.newValue);
  });
})();
