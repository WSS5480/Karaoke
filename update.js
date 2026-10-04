/* Keeps installed apps up to date on their own: no re-adding or re-saving needed.
   Checks for a new version every time the app opens or comes back to the screen,
   and reloads once when a new version has been installed. */
(function () {
  if (!("serviceWorker" in navigator)) return;
  var m = location.pathname.match(/^\/b\/[a-z0-9-]+\//), base = m ? m[0] : "/";
  var hadController = !!navigator.serviceWorker.controller, reloaded = false;
  navigator.serviceWorker.register(base + "sw.js").then(function (reg) {
    var check = function () { reg.update().catch(function () {}); };
    check();
    document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") check(); });
    setInterval(check, 30 * 60 * 1000);
  }).catch(function () {});
  navigator.serviceWorker.addEventListener("controllerchange", function () {
    if (!hadController) { hadController = true; return; }      // first install: nothing to refresh
    if (reloaded) return; reloaded = true;
    // don't interrupt someone typing: wait until they're not in a text box
    var go = function () { var a = document.activeElement; if (a && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) return setTimeout(go, 3000); location.reload(); };
    go();
  });
})();

/* Pull down to refresh, on every page (installed home-screen apps don't have it built in).
   Only starts when the page is scrolled to the very top and the finger isn't inside a scrolling box or a text field. */
(function () {
  if (!("ontouchstart" in window)) return;
  var startY = null, dist = 0, armed = false, TRIGGER = 80;
  var tip = document.createElement("div");
  tip.setAttribute("aria-hidden", "true");
  tip.style.cssText = "position:fixed;left:50%;top:0;z-index:2147483646;transform:translate(-50%,-60px);transition:transform .15s;" +
    "background:#131713;color:#5fd36e;border:1px solid #39b54a;border-radius:999px;padding:8px 14px;font:600 14px system-ui,-apple-system,sans-serif;" +
    "box-shadow:0 6px 20px rgba(0,0,0,.5);pointer-events:none";
  tip.textContent = "↓ Pull to refresh";
  var add = function () { if (document.body && !tip.parentNode) document.body.appendChild(tip); };
  if (document.body) add(); else document.addEventListener("DOMContentLoaded", add);
  function scrolledInside(el) {
    for (; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
      if (/INPUT|TEXTAREA|SELECT/.test(el.tagName)) return true;
      if (el.scrollTop > 0) return true;
      var oy = getComputedStyle(el).overflowY;
      if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight && el.scrollTop > 0) return true;
    }
    return false;
  }
  function openModal() { return !!document.querySelector(".tmodal:not([hidden]),.forcepin:not([hidden]),.iosguide:not([hidden])"); }
  window.addEventListener("touchstart", function (e) {
    startY = null; dist = 0; armed = false;
    if (e.touches.length !== 1 || (window.scrollY || document.documentElement.scrollTop) > 0 || scrolledInside(e.target) || openModal()) return;
    startY = e.touches[0].clientY;
  }, { passive: true });
  window.addEventListener("touchmove", function (e) {
    if (startY === null) return;
    dist = e.touches[0].clientY - startY;
    if (dist <= 0 || (window.scrollY || document.documentElement.scrollTop) > 0) { tip.style.transform = "translate(-50%,-60px)"; armed = false; return; }
    var y = Math.min(dist / 2, 70) - 50;
    armed = dist > TRIGGER;
    tip.textContent = armed ? "↻ Release to refresh" : "↓ Pull to refresh";
    tip.style.transform = "translate(-50%," + (y + 10) + "px)";
  }, { passive: true });
  window.addEventListener("touchend", function () {
    if (startY === null) return;
    startY = null;
    if (armed) { tip.textContent = "Refreshing…"; tip.style.transform = "translate(-50%,16px)"; setTimeout(function () { location.reload(); }, 150); }
    else tip.style.transform = "translate(-50%,-60px)";
    armed = false;
  }, { passive: true });
})();
