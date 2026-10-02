/* Page size control for laptops: shrink or grow the whole page (everything stays, just smaller).
   Shows a small − / + pill in the corner on wider screens; remembers the size per page. */
(function () {
  var KEY = "dive_zoom_" + location.pathname, steps = [0.5, 0.6, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25];
  var z = 1;
  try { z = parseFloat(localStorage.getItem(KEY)) || 1; } catch (e) {}
  function apply() { document.documentElement.style.zoom = z === 1 ? "" : String(z); if (label) label.textContent = Math.round(z * 100) + "%"; }
  function step(d) {
    var i = steps.indexOf(z); if (i < 0) i = steps.indexOf(1);
    i = Math.max(0, Math.min(steps.length - 1, i + d)); z = steps[i];
    try { localStorage.setItem(KEY, String(z)); } catch (e) {}
    apply();
  }
  var label = null;
  apply();
  function mount() {
    var css = document.createElement("style");
    css.textContent = "#diveZoom{position:fixed;right:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));z-index:9997;display:flex;align-items:center;gap:2px;background:#131713;border:1px solid #2b352b;border-radius:999px;padding:3px;font:600 13px/1 Outfit,system-ui,-apple-system,sans-serif;color:#eef3ee;box-shadow:0 4px 18px rgba(0,0,0,.5)}" +
      "#diveZoom button{font:inherit;font-size:16px;width:30px;height:30px;border-radius:50%;border:0;background:#1b211b;color:#eef3ee;cursor:pointer}" +
      "#diveZoom button:hover{background:#39b54a;color:#041206}#diveZoom span{min-width:44px;text-align:center;cursor:pointer}" +
      "@media (max-width:699px){#diveZoom{display:none}}@media print{#diveZoom{display:none!important}}";
    document.head.appendChild(css);
    var box = document.createElement("div"); box.id = "diveZoom"; box.setAttribute("role", "group"); box.setAttribute("aria-label", "Page size");
    box.innerHTML = '<button type="button" aria-label="Smaller">−</button><span title="Tap to reset to 100%"></span><button type="button" aria-label="Bigger">+</button>';
    label = box.querySelector("span");
    box.children[0].addEventListener("click", function () { step(-1); });
    box.children[2].addEventListener("click", function () { step(1); });
    label.addEventListener("click", function () { z = 1; try { localStorage.removeItem(KEY); } catch (e) {} apply(); });
    document.body.appendChild(box); apply();
    // keyboard: Alt + minus / Alt + plus / Alt + 0
    document.addEventListener("keydown", function (e) {
      if (!e.altKey) return;
      if (e.key === "-" || e.key === "–") { e.preventDefault(); step(-1); }
      else if (e.key === "=" || e.key === "+") { e.preventDefault(); step(1); }
      else if (e.key === "0") { e.preventDefault(); z = 1; try { localStorage.removeItem(KEY); } catch (er) {} apply(); }
    });
  }
  if (document.body) mount(); else document.addEventListener("DOMContentLoaded", mount);
})();
