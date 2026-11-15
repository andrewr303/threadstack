// Research fixture, page world: make `window.self !== window.top` read "not framed" while the
// bare name `self` still means this page's own window.
(function () {
  var root = document.documentElement;
  if (!root || !root.hasAttribute('data-spike-top')) return;
  root.removeAttribute('data-spike-top');
  var w = window;
  try {
    var s = document.createElement('script');
    s.textContent = "let self = window; document.documentElement.setAttribute('data-spike-self', '');";
    (document.head || root).appendChild(s);
    s.remove();
  } catch (_) {}
  if (!root.hasAttribute('data-spike-self')) return;
  root.removeAttribute('data-spike-self');
  try {
    Object.defineProperty(w, 'self', { configurable: true, enumerable: true, get: function () { return w.top; }, set: function () {} });
  } catch (_) {}
})();
