/* "Add as an app" bar for the extra Dive pages (stats, ads, wheel, TV, history, wall).
   Each page has its own manifest and icon, so each one installs as its own app.
   Android/Chrome: one tap (real install prompt). iPhone: shows the Share → Add to Home Screen guide. */
(function () {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(function () {});
  var standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  if (standalone) return;
  var name = (document.querySelector('meta[name="apple-mobile-web-app-title"]') || {}).content || "The Dive";
  var icon = (document.querySelector('link[rel="apple-touch-icon"]') || {}).href || "/logo.png";
  var KEY = "dive_install_x_" + location.pathname;
  try { if (sessionStorage.getItem(KEY) === "1") return; } catch (e) {}
  var ios = /iphone|ipad|ipod/i.test(navigator.userAgent), iosChrome = ios && /CriOS/i.test(navigator.userAgent);

  var css = document.createElement("style");
  css.textContent =
    "#diveA2hs{position:fixed;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));z-index:9998;display:flex;gap:10px;align-items:center;background:#131713;border:1px solid #39b54a;border-radius:16px;padding:10px 12px;color:#eef3ee;font:14px/1.35 Outfit,system-ui,-apple-system,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.6);max-width:520px;margin:0 auto}" +
    "#diveA2hs img{width:42px;height:42px;border-radius:10px;flex:none}" +
    "#diveA2hs .tx{flex:1;min-width:0}#diveA2hs .tx b{display:block;font-size:15px}" +
    "#diveA2hs button{font:inherit;font-weight:700;border-radius:999px;padding:9px 15px;border:0;background:#39b54a;color:#041206;cursor:pointer;flex:none}" +
    "#diveA2hs .x{background:none;color:#9fae9f;padding:4px 6px;font-size:20px;font-weight:400}" +
    "#diveGuide{position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.82);display:flex;flex-direction:column;align-items:center;justify-content:flex-end;padding:24px 20px calc(70px + env(safe-area-inset-bottom,0px));color:#fff;font:17px/1.3 Outfit,system-ui,-apple-system,sans-serif}" +
    "#diveGuide.top{justify-content:flex-start;padding-top:calc(24px + env(safe-area-inset-top,0px))}" +
    "#diveGuide .box{background:#131713;border:2px solid #39b54a;border-radius:18px;padding:18px;max-width:340px;display:flex;flex-direction:column;gap:12px}" +
    "#diveGuide .st{display:flex;gap:12px;align-items:center}#diveGuide .n{width:30px;height:30px;border-radius:50%;background:#39b54a;color:#041206;font-weight:800;display:grid;place-items:center;flex:none}" +
    "#diveGuide .ar{font-size:64px;line-height:1;color:#5fd36e;margin-top:14px}#diveGuide.top .ar{order:-1;align-self:flex-end;margin:0 10px 8px 0}" +
    "#diveGuide .cl{background:none;border:0;color:#9fae9f;font:inherit;text-decoration:underline;padding:6px;cursor:pointer}" +
    "#diveA2hs[hidden],#diveGuide[hidden]{display:none!important}" +
    "@media print{#diveA2hs,#diveGuide{display:none!important}}";
  document.head.appendChild(css);

  var bar = document.createElement("div"); bar.id = "diveA2hs"; bar.hidden = true;
  bar.innerHTML = '<img alt=""><div class="tx"><b></b><span>Add it to your home screen.</span></div><button type="button" class="go">Add</button><button type="button" class="x" aria-label="Hide">×</button>';
  bar.querySelector("img").src = icon; bar.querySelector("b").textContent = "Get the " + name + " app";
  var guide = document.createElement("div"); guide.id = "diveGuide"; guide.hidden = true; guide.setAttribute("role", "dialog");
  guide.innerHTML = '<div class="box"><div class="st"><span class="n">1</span><span>Tap the <b>Share</b> button ⬆︎ ' + (iosChrome ? "at the top right" : "below") + '</span></div><div class="st"><span class="n">2</span><span>Scroll down, tap <b>Add to Home Screen</b></span></div><div class="st"><span class="n">3</span><span>Tap <b>Add</b>. Done!</span></div><button type="button" class="cl">Close</button></div><div class="ar" aria-hidden="true">' + (iosChrome ? "⬆" : "⬇") + "</div>";
  if (iosChrome) guide.classList.add("top");
  function mount() { document.body.appendChild(bar); document.body.appendChild(guide); if (ios) setTimeout(function () { bar.hidden = false; }, 1500); }
  if (document.body) mount(); else document.addEventListener("DOMContentLoaded", mount);

  var evt = null;
  window.addEventListener("beforeinstallprompt", function (e) { e.preventDefault(); evt = e; bar.hidden = false; });
  bar.querySelector(".go").addEventListener("click", function () {
    if (ios) { guide.hidden = false; return; }
    if (evt) { evt.prompt(); evt.userChoice.then(function () { bar.hidden = true; }); evt = null; }
  });
  bar.querySelector(".x").addEventListener("click", function () { bar.hidden = true; try { sessionStorage.setItem(KEY, "1"); } catch (e) {} });
  guide.addEventListener("click", function (e) { if (e.target === guide || e.target.className === "cl") guide.hidden = true; });
  window.addEventListener("appinstalled", function () { bar.hidden = true; });
  // the TV and wheel go full-screen for casting: keep the bar off the big screen
  document.addEventListener("click", function () { if (document.querySelector(".app.tv")) bar.hidden = true; }, true);
})();
