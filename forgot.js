/* "Forgot PIN?" for every sign-in screen: a code is texted to the phone on file, then they pick a new PIN.
   Use: diveForgotLink(elementToPutTheLinkAfter, { kinds: [{ k: "host", label: "My DJ or staff login", name: true }, { k: "house", label: "House PIN" }], done: fn }) */
(function () {
  var m = location.pathname.match(/^\/b\/[a-z0-9-]+\//), base = m ? m[0].replace(/\/$/, "") : "";
  var css = ".fpw{position:fixed;inset:0;z-index:2147483600;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;padding:16px}" +
    ".fpw .bx{background:#131713;border:2px solid #39b54a;border-radius:18px;padding:18px;max-width:420px;width:100%;display:flex;flex-direction:column;gap:10px;color:#eef3ee;font:16px/1.4 system-ui,-apple-system,'Segoe UI',sans-serif;max-height:92vh;overflow:auto}" +
    ".fpw h2{margin:0;font-size:20px}.fpw p{margin:0;color:#9fae9f;font-size:14px}" +
    ".fpw input{font:inherit;font-size:17px;padding:12px;border-radius:12px;border:1px solid #2b352b;background:#0a0c0a;color:#eef3ee;width:100%;box-sizing:border-box;letter-spacing:0}" +
    ".fpw .go{font:inherit;font-weight:800;font-size:17px;padding:13px;border-radius:999px;border:0;background:#39b54a;color:#041206;cursor:pointer}" +
    ".fpw .lk{background:none;border:0;color:#9fae9f;text-decoration:underline;font:inherit;font-size:15px;cursor:pointer;padding:6px}" +
    ".fpw .kinds{display:flex;flex-direction:column;gap:6px}.fpw .kinds button{font:inherit;padding:11px;border-radius:12px;border:1px solid #2b352b;background:#1b211b;color:#eef3ee;cursor:pointer;text-align:left}" +
    ".fpw .kinds button[aria-pressed=true]{border-color:#39b54a;background:rgba(57,181,74,.18)}.fpw .er{color:#ff8080;font-size:14px;min-height:1em}.fpw .ok{color:#5fd36e;font-weight:700}" +
    ".fplink{background:none;border:0;color:#9fae9f;text-decoration:underline;font:inherit;font-size:15px;cursor:pointer;padding:8px;display:block;margin:6px auto 0}";
  function addCss() { if (document.getElementById("fpcss")) return; var s = document.createElement("style"); s.id = "fpcss"; s.textContent = css; document.head.appendChild(s); }
  function h(tag, attrs, text) { var e = document.createElement(tag); for (var k in (attrs || {})) e.setAttribute(k, attrs[k]); if (text != null) e.textContent = text; return e; }
  async function post(path, body) {
    var r = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    var j = {}; try { j = await r.json(); } catch (e) {}
    if (!r.ok) throw new Error(j.error || "Didn't work. Try again.");
    return j;
  }
  window.diveForgot = function (opts) {
    addCss(); opts = opts || {}; var kinds = opts.kinds || [];
    var kind = kinds[0] || {}, wrap = h("div", { class: "fpw", role: "dialog", "aria-modal": "true" }), bx = h("div", { class: "bx" });
    wrap.appendChild(bx); document.body.appendChild(wrap);
    var close = function () { wrap.remove(); };
    wrap.addEventListener("click", function (e) { if (e.target === wrap) close(); });
    function step1() {
      bx.innerHTML = "";
      bx.appendChild(h("h2", null, "Forgot your PIN?"));
      bx.appendChild(h("p", null, "We'll text a code to the phone saved for this login. / Te mandamos un código por mensaje."));
      var nameIn = h("input", { placeholder: "Your login name", autocomplete: "username", maxlength: "30" });
      if (kinds.length > 1) {
        var ks = h("div", { class: "kinds" });
        kinds.forEach(function (k) { var b = h("button", { type: "button", "aria-pressed": String(k === kind) }, k.label); b.onclick = function () { kind = k; step1(); }; ks.appendChild(b); });
        bx.appendChild(ks);
      }
      if (kind.name) bx.appendChild(nameIn);
      var ph = h("input", { placeholder: "Phone number", inputmode: "tel", autocomplete: "tel", maxlength: "20" }), er = h("div", { class: "er", role: "alert" }), go = h("button", { class: "go", type: "button" }, "Text me a code");
      bx.appendChild(ph); bx.appendChild(er); bx.appendChild(go);
      var cx = h("button", { class: "lk", type: "button" }, "Cancel"); cx.onclick = close; bx.appendChild(cx);
      go.onclick = async function () {
        er.textContent = ""; go.disabled = true;
        try { await post("/api/forgot/start", { kind: kind.k, name: nameIn.value.trim(), phone: ph.value }); step2(nameIn.value.trim(), ph.value); }
        catch (e) { er.textContent = e.message; go.disabled = false; }
      };
      (kind.name ? nameIn : ph).focus();
    }
    function step2(name, phone) {
      bx.innerHTML = "";
      bx.appendChild(h("h2", null, "Enter the code"));
      bx.appendChild(h("p", null, "If that number is on file, a code is on its way. No phone on file? Ask the owner to reset your PIN."));
      var code = h("input", { placeholder: "6-digit code", inputmode: "numeric", autocomplete: "one-time-code", maxlength: "8" }),
          pin = h("input", { placeholder: "New PIN (4–8 digits)", inputmode: "numeric", type: "password", maxlength: "8", autocomplete: "new-password" }),
          er = h("div", { class: "er", role: "alert" }), go = h("button", { class: "go", type: "button" }, "Save new PIN");
      bx.appendChild(code); bx.appendChild(pin); bx.appendChild(er); bx.appendChild(go);
      var back = h("button", { class: "lk", type: "button" }, "Send a new code"); back.onclick = step1; bx.appendChild(back);
      go.onclick = async function () {
        er.textContent = ""; go.disabled = true;
        try {
          await post("/api/forgot/finish", { kind: kind.k, name: name, phone: phone, code: code.value, pin: pin.value });
          bx.innerHTML = ""; bx.appendChild(h("h2", null, "PIN changed ✓")); bx.appendChild(h("p", { class: "ok" }, "Sign in with your new PIN."));
          var ok = h("button", { class: "go", type: "button" }, "OK"); ok.onclick = function () { close(); if (opts.done) opts.done(); }; bx.appendChild(ok);
        } catch (e) { er.textContent = e.message; go.disabled = false; }
      };
      code.focus();
    }
    step1();
  };
  window.diveForgotLink = function (after, opts) {
    if (!after || after.parentNode == null) return; addCss();
    var b = h("button", { type: "button", class: "fplink" }, "Forgot PIN?");
    b.onclick = function () { window.diveForgot(opts); };
    after.parentNode.insertBefore(b, after.nextSibling);
  };
})();
