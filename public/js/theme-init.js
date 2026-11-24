// Applies the theme and the store's brand colour before the first paint, so pages never
// flash white or in the wrong colours. The saved choice wins; otherwise the device setting.
(function () {
  var root = document.documentElement, t = null;
  try { t = localStorage.getItem('alaan.theme'); } catch (e) {}
  if (t !== 'light' && t !== 'dark') t = window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  root.dataset.theme = t;
  try { var css = localStorage.getItem('alaan.brandcss'); if (css) { var s = document.createElement('style'); s.id = 'brand-style'; s.textContent = css; document.head.appendChild(s); } } catch (e) {}
  // Web font: loaded without blocking the first paint, then switched on. (Done here, not with an
  // inline onload="", because the security policy only allows scripts from the store's own files.)
  document.addEventListener('DOMContentLoaded', function () {
    var l = document.querySelector('link[data-font]'); if (!l) return;
    var on = function () { l.media = 'all'; };
    try { if (l.sheet) on(); } catch (e) { on(); }
    l.addEventListener('load', on);
  });
})();
