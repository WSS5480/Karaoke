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
