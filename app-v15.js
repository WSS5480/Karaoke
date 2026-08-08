/**
 * Tesla Monitor — tiny Node server (no dependencies).
 *
 * Serves the dashboard and exposes /api/vehicle.
 *  - Without credentials: /api/vehicle returns {demo:true} and the
 *    dashboard runs on its built-in demo dataset.
 *  - With credentials (env vars below): proxies Tesla Fleet API
 *    vehicle_data and maps it to the dashboard's shape. Your token
 *    lives ONLY here on the server, never in the browser.
 *
 * Env vars:
 *   TESLA_TOKEN       - Fleet API access token (Bearer). The only required one:
 *                       the server auto-discovers your vehicle from /api/1/vehicles.
 *   TESLA_VEHICLE_ID  - optional override if you have more than one Tesla
 *   TESLA_REGION_BASE - optional, defaults to the North America endpoint
 */
"use strict";

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const BASE = process.env.TESLA_REGION_BASE || "https://fleet-api.prd.na.vn.cloud.tesla.com";
const AUTH_BASE = "https://auth.tesla.com/oauth2/v3";
const APP_DOMAIN = process.env.APP_DOMAIN || "buddy-ev-monitor.onrender.com";
const CLIENT_ID = process.env.TESLA_CLIENT_ID || "604018cb-0a6f-4bcb-ab60-810f495e0869";
const CLIENT_SECRET = process.env.TESLA_CLIENT_SECRET || "";
const REDIRECT_URI = `https://${APP_DOMAIN}/auth/callback`;
const SCOPES = "openid offline_access vehicle_device_data vehicle_location vehicle_cmds vehicle_charging_cmds";

/* ---- per-user sessions ----
   Each visitor signs in with THEIR Tesla account (/auth/login). Their refresh
   token is stored in an encrypted, HttpOnly cookie, so each browser sees its
   own car. Falls back to env TESLA_REFRESH_TOKEN / TESLA_TOKEN (owner mode)
   for requests without a cookie -- delete those env vars once friends use it. */
const COOKIE = "bem_rt";
const KEY = crypto.createHash("sha256").update(CLIENT_SECRET || "bem-dev-key").digest();

function encRT(rt) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const ct = Buffer.concat([c.update(rt, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64url");
}
function decRT(b64) {
  try {
    const buf = Buffer.from(b64, "base64url");
    const d = crypto.createDecipheriv("aes-256-gcm", KEY, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
  } catch (e) { return null; }
}
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || "").split(";").forEach(p => {
    const i = p.indexOf("="); if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  return out;
}
function cookieSet(rt) {
  return `${COOKIE}=${encRT(rt)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=15552000`;
}
const COOKIE_CLEAR = `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

async function tokenPost(params) {
  const r = await fetch(`${AUTH_BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString()
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`auth ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  return j;
}

// rtHash -> { access_token, refresh_token, expires_at, vehicleId }
const sessions = new Map();

/** Resolve the caller's Tesla access token: cookie, then x-bem-rt header
    (localStorage fallback for cookie-hostile browsers), then env fallback. */
async function getSession(req) {
  const cookieRt = decRT(parseCookies(req)[COOKIE] || "");
  const headerRt = cookieRt ? null : decRT(String(req.headers["x-bem-rt"] || ""));
  const userRt = cookieRt || headerRt;
  const fromUser = !!userRt;
  const rt = userRt || process.env.TESLA_REFRESH_TOKEN || null;
  if (!rt) {
    if (process.env.TESLA_TOKEN)
      return { token: process.env.TESLA_TOKEN, sess: { vehicleId: null }, fromCookie: false, setCookie: null, newEnc: null };
    return null;
  }
  const key = crypto.createHash("sha256").update(rt).digest("hex").slice(0, 24);
  let sess = sessions.get(key);
  if (sess && Date.now() < sess.expires_at - 60000)
    return { token: sess.access_token, sess, fromCookie: fromUser, setCookie: null, newEnc: null };
  if (!CLIENT_SECRET) return null;
  const j = await tokenPost({
    grant_type: "refresh_token", client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET, refresh_token: (sess && sess.refresh_token) || rt
  });
  sess = {
    access_token: j.access_token,
    refresh_token: j.refresh_token || rt,
    expires_at: Date.now() + (j.expires_in || 28800) * 1000,
    vehicleId: (sess && sess.vehicleId) || null
  };
  sessions.set(key, sess);
  const rotated = fromUser && sess.refresh_token !== userRt;
  return {
    token: sess.access_token, sess, fromCookie: fromUser,
    setCookie: rotated ? cookieSet(sess.refresh_token) : null,
    newEnc: rotated ? encRT(sess.refresh_token) : null
  };
}

function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function page(res, title, bodyHtml, code = 200) {
  res.writeHead(code, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
  <style>body{background:#171a20;color:#f4f4f4;font-family:-apple-system,sans-serif;padding:28px;line-height:1.6}
  a{color:#7ea2f0}code{background:#262b33;padding:2px 7px;border-radius:6px;word-break:break-all;display:inline-block}
  .card{background:#1c2027;border:1px solid #262b33;border-radius:14px;padding:18px;margin:14px 0}</style>
  <title>${esc(title)}</title></head><body><h2>${esc(title)}</h2>${bodyHtml}</body></html>`);
}

function cToF(c){ return c == null ? null : Math.round(c * 9 / 5 + 32); }

/** Map a Fleet API vehicle_data response to the dashboard's data shape. */
function mapFleetToApp(v) {
  const cs = v.charge_state || {};
  const cl = v.climate_state || {};
  const vs = v.vehicle_state || {};
  return {
    display_name: v.display_name || "My Tesla",
    state: v.state,
    charge_state: {
      charging_state: cs.charging_state || "Disconnected",
      battery_level: cs.battery_level ?? 0,
      battery_range: Math.round(cs.battery_range ?? 0),
      charge_limit_soc: cs.charge_limit_soc ?? 80,
      charger_power: cs.charger_power ?? 0,
      charger_actual_current: cs.charger_actual_current ?? 0,
      charger_voltage: cs.charger_voltage ?? 0,
      charge_energy_added: cs.charge_energy_added ?? 0,
      minutes_to_full_charge: cs.minutes_to_full_charge ?? 0,
      // Charge-curve history needs Fleet Telemetry + storage (roadmap).
      session: [[0, cs.battery_level ?? 0]]
    },
    climate_state: {
      inside_temp_f: cToF(cl.inside_temp) ?? 0,
      outside_temp_f: cToF(cl.outside_temp) ?? 0,
      driver_temp_setting_f: cToF(cl.driver_temp_setting) ?? 70,
      is_climate_on: !!cl.is_climate_on
    },
    drive_state: {
      shift_state: (v.drive_state || {}).shift_state || null,
      latitude: (v.drive_state || {}).latitude ?? null,
      longitude: (v.drive_state || {}).longitude ?? null,
      speed: (v.drive_state || {}).speed ?? null,
      address: null
    },
    vehicle_state: {
      odometer: Math.round(vs.odometer ?? 0),
      car_version: (vs.car_version || "").split(" ")[0],
      locked: !!vs.locked,
      tpms: [vs.tpms_pressure_fl, vs.tpms_pressure_fr, vs.tpms_pressure_rl, vs.tpms_pressure_rr]
        .map(p => (p ? Math.round(p * 14.5) : null)), // bar -> psi
      sentry_mode: !!vs.sentry_mode,
      doors_open: [vs.df, vs.dr, vs.pf, vs.pr].some(Boolean),
      windows_open: [vs.fd_window, vs.fp_window, vs.rd_window, vs.rp_window].some(Boolean),
      update_status: (vs.software_update || {}).status || "",
      update_version: ((vs.software_update || {}).version || "").split(" ")[0]
    },
    // Used by the frontend to render the REAL car image (Tesla's own
    // configurator render matching your color and wheels).
    vehicle_config: {
      car_type: (v.vehicle_config || {}).car_type || "modely",
      exterior_color: (v.vehicle_config || {}).exterior_color || null,
      wheel_type: (v.vehicle_config || {}).wheel_type || null,
      trim_badging: (v.vehicle_config || {}).trim_badging || null,
      roof_color: (v.vehicle_config || {}).roof_color || null,
      spoiler_type: (v.vehicle_config || {}).spoiler_type || null,
      exterior_trim: (v.vehicle_config || {}).exterior_trim || null
    },
    // Driving history also needs telemetry/storage; demo shape for now.
    week: []
  };
}

/** First vehicle on the account (cached per session). Env override for owner mode. */
async function getVehicleIdFor(g) {
  if (!g.fromCookie && process.env.TESLA_VEHICLE_ID) return process.env.TESLA_VEHICLE_ID;
  if (g.sess.vehicleId) return g.sess.vehicleId;
  const r = await fetch(`${BASE}/api/1/vehicles`, {
    headers: { Authorization: `Bearer ${g.token}` }
  });
  if (!r.ok) throw new Error(`Fleet API vehicles ${r.status}`);
  const j = await r.json();
  const list = j.response || [];
  if (!list.length) throw new Error("No vehicles on this Tesla account");
  g.sess.vehicleId = list[0].id;
  g.sess.displayName = list[0].display_name || null;
  return g.sess.vehicleId;
}

async function handleVehicle(req, res) {
  let g = null;
  try { g = await getSession(req); } catch (e) { console.error("session error:", e.message); }
  const baseHeaders = { "Content-Type": "application/json", "Cache-Control": "no-store" };
  if (!g) {
    res.writeHead(200, baseHeaders);
    return res.end(JSON.stringify({ demo: true }));
  }
  const headers = Object.assign({}, baseHeaders);
  if (g.setCookie) headers["Set-Cookie"] = g.setCookie;
  if (g.newEnc) headers["x-bem-rt-new"] = g.newEnc;
  try {
    const vid = await getVehicleIdFor(g);
    const r = await fetch(`${BASE}/api/1/vehicles/${vid}/vehicle_data?endpoints=` + encodeURIComponent("charge_state;climate_state;drive_state;location_data;vehicle_state;vehicle_config"), {
      headers: { Authorization: `Bearer ${g.token}` }
    });
    if (!r.ok) { const err = new Error(`Fleet API ${r.status}`); err.status = r.status; throw err; }
    const j = await r.json();
    if (g.sess.displayName && (!j.response.display_name || j.response.display_name === "My Tesla"))
      j.response.display_name = g.sess.displayName;
    res.writeHead(200, headers);
    res.end(JSON.stringify(mapFleetToApp(j.response)));
  } catch (e) {
    console.error("Fleet API error:", e.message);
    const noVehicles = /no vehicles/i.test(e.message);
    const asleep = !noVehicles && (e.status === 408 || /408|unavailable|asleep|offline|timeout/i.test(e.message));
    res.writeHead(200, headers);
    res.end(JSON.stringify({ signed_in: true, asleep, no_vehicles: noVehicles, error: e.message }));
  }
}

async function handleWake(req, res) {
  let g = null;
  try { g = await getSession(req); } catch (e) {}
  const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
  if (!g) return send(401, { error: "not signed in" });
  try {
    const vid = await getVehicleIdFor(g);
    const r = await fetch(`${BASE}/api/1/vehicles/${vid}/wake_up`, {
      method: "POST", headers: { Authorization: `Bearer ${g.token}` }
    });
    const body = await r.text().catch(() => "");
    send(200, { ok: r.ok, status: r.status, detail: body.slice(0, 200) });
  } catch (e) { send(200, { ok: false, error: e.message }); }
}

const DEMO_CHARGERS = { demo: true, superchargers: [
  { name: "Menlo Park, CA", distance_miles: 1.2, available_stalls: 9, total_stalls: 12 },
  { name: "Palo Alto - Stanford Shopping Center", distance_miles: 2.8, available_stalls: 4, total_stalls: 16 },
  { name: "Redwood City, CA", distance_miles: 4.1, available_stalls: 11, total_stalls: 20 }
]};

async function handleChargers(req, res) {
  let g = null;
  try { g = await getSession(req); } catch (e) {}
  const send = (obj) => { res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(obj)); };
  if (!g) return send(DEMO_CHARGERS);
  try {
    const vid = await getVehicleIdFor(g);
    const r = await fetch(`${BASE}/api/1/vehicles/${vid}/nearby_charging_sites?count=8`, {
      headers: { Authorization: `Bearer ${g.token}` }
    });
    if (!r.ok) throw new Error(`nearby_charging_sites ${r.status}`);
    const j = await r.json();
    const list = ((j.response || {}).superchargers || []).map(c => ({
      name: c.name,
      distance_miles: Math.round((c.distance_miles ?? 0) * 10) / 10,
      available_stalls: c.available_stalls ?? null,
      total_stalls: c.total_stalls ?? null
    }));
    send({ superchargers: list });
  } catch (e) {
    console.error("chargers error:", e.message);
    send(DEMO_CHARGERS);
  }
}

/* ---- one-time setup & OAuth routes ---- */

function servePublicKey(res) {
  fs.readFile(path.join(__dirname, "tesla-public-key.pem"), (err, buf) => {
    if (err) { res.writeHead(404); return res.end("missing key"); }
    res.writeHead(200, { "Content-Type": "application/x-pem-file" });
    res.end(buf);
  });
}

async function handleRegister(res) {
  if (!CLIENT_SECRET) return page(res, "Missing secret",
    `<div class="card">Set the <code>TESLA_CLIENT_SECRET</code> environment variable in Render first, then reload this page.</div>`, 400);
  try {
    const pt = await tokenPost({
      grant_type: "client_credentials", client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET, scope: SCOPES, audience: BASE
    });
    const r = await fetch(`${BASE}/api/1/partner_accounts`, {
      method: "POST",
      headers: { Authorization: `Bearer ${pt.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ domain: APP_DOMAIN })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`partner_accounts ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
    page(res, "Registered ✓",
      `<div class="card">Your app domain <code>${esc(APP_DOMAIN)}</code> is registered with Tesla.</div>
       <div class="card">Next: <a href="/auth/login">sign in with your Tesla account →</a></div>`);
  } catch (e) {
    page(res, "Registration failed", `<div class="card"><code>${esc(e.message)}</code></div>
      <div class="card">Check that TESLA_CLIENT_SECRET is set correctly in Render, then reload.</div>`, 500);
  }
}

function handleLogin(res) {
  const u = `${AUTH_BASE}/authorize?response_type=code&client_id=${encodeURIComponent(CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent(SCOPES)}` +
    `&state=bem${Math.floor(Math.random() * 1e9)}`;
  res.writeHead(302, { Location: u });
  res.end();
}

async function handleCallback(req, res) {
  const q = new URL(req.url, `https://${APP_DOMAIN}`).searchParams;
  const code = q.get("code");
  if (!code) return page(res, "No code", `<div class="card">Tesla did not return a code. <a href="/auth/login">Try again</a></div>`, 400);
  try {
    const j = await tokenPost({
      grant_type: "authorization_code", client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      code, redirect_uri: REDIRECT_URI, audience: BASE
    });
    if (!j.refresh_token) throw new Error("No refresh token returned");
    const enc = encRT(j.refresh_token);
    // 200 page (not a redirect): cookies set on a top-level document load are
    // accepted by strict browsers, and we ALSO stash the login in localStorage
    // so cookie-hostile browsers still work via the x-bem-rt header.
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Set-Cookie": cookieSet(j.refresh_token) });
    res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>body{background:#171a20;color:#f4f4f4;font-family:-apple-system,sans-serif;padding:28px;line-height:1.6;text-align:center}
    a.btn{display:block;margin-top:24px;background:#3e6ae1;color:#fff;padding:14px;border-radius:12px;font-weight:600;text-decoration:none;font-size:16px}</style>
    <title>Connected</title></head><body>
    <h2>Connected &#10003;</h2><p>Your Tesla is linked to this browser.</p>
    <a class="btn" href="/">Open my dashboard &rarr;</a>
    <script>try{localStorage.setItem("bem_rt","${enc}");}catch(e){}
    setTimeout(function(){ location.href = "/"; }, 1200);</script>
    </body></html>`);
  } catch (e) {
    page(res, "Sign-in failed", `<div class="card"><code>${esc(e.message)}</code></div>
      <div class="card"><a href="/auth/login">Try again</a></div>`, 500);
  }
}

async function handleHandoffLink(req, res) {
  let g = null;
  try { g = await getSession(req); } catch (e) {}
  const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
  if (!g || !g.fromCookie || !g.sess.refresh_token) return send(401, { error: "not signed in" });
  send(200, { url: `https://${APP_DOMAIN}/auth/claim#${encRT(g.sess.refresh_token)}` });
}

function handleClaim(res) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
  <style>body{background:#171a20;color:#f4f4f4;font-family:-apple-system,sans-serif;padding:28px;text-align:center}</style>
  <title>Linking…</title></head><body><h2>Linking this browser…</h2>
  <script>
    var h = location.hash.slice(1);
    if (h) {
      try { localStorage.setItem("bem_rt", h); } catch(e) {}
      try { document.cookie = "bem_rt=" + h + "; path=/; max-age=15552000; secure; samesite=lax"; } catch(e) {}
    }
    location.replace("/");
  </script></body></html>`);
}

function handleLogout(res) {
  res.writeHead(302, { "Set-Cookie": COOKIE_CLEAR, Location: "/" });
  res.end();
}

const server = http.createServer((req, res) => {
  const p = req.url.split("?")[0];
  if (p === "/api/vehicle") return handleVehicle(req, res);
  if (p === "/api/chargers") return handleChargers(req, res);
  if (p === "/api/wake") return handleWake(req, res);
  if (p === "/healthz") { res.writeHead(200); return res.end("ok"); }
  if (p === "/.well-known/appspecific/com.tesla.3p.public-key.pem") return servePublicKey(res);
  if (p === "/setup/register") return handleRegister(res);
  if (p === "/auth/login") return handleLogin(res);
  if (p === "/auth/callback") return handleCallback(req, res);
  if (p === "/auth/logout") return handleLogout(res);
  if (p === "/auth/handoff-link") return handleHandoffLink(req, res);
  if (p === "/auth/claim") return handleClaim(res);
  // the whole dashboard is embedded below - server.js is the ONLY app file
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(INDEX_HTML);
});

server.listen(PORT, () => console.log(`Tesla Monitor on :${PORT}`));







/* ============ EMBEDDED DASHBOARD (v15) ============ */
const INDEX_HTML = "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"UTF-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0, viewport-fit=cover\">\n<title>Model Y</title>\n<link rel=\"stylesheet\" href=\"https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css\">\n<script src=\"https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js\"></script>\n<style>\n  :root{\n    --bg:#171a20;            /* Tesla brand dark */\n    --card:#1c2027;\n    --card-border:#262b33;\n    --elev:#2b3038;\n    --ink:#f4f4f4;\n    --ink-2:#9b9fa5;\n    --ink-3:#6b7076;\n    --accent:#3e6ae1;        /* Tesla blue */\n    --green:#3dbe5b;         /* charge green */\n    --green-track:#1e3a28;\n    --red:#e82127;\n    --hairline:#262b33;\n    --radius:16px;\n  }\n  *{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}\n  html,body{background:var(--bg)}\n  body{\n    font-family:\"Gotham SSm\",\"Gotham\",-apple-system,BlinkMacSystemFont,\"Inter\",\"Segoe UI\",Roboto,\"Helvetica Neue\",Arial,sans-serif;\n    color:var(--ink);\n    -webkit-font-smoothing:antialiased;\n    min-height:100vh;\n    display:flex;justify-content:center;\n  }\n  .app{width:100%;max-width:430px;padding:20px 20px 40px;position:relative}\n\n  /* ---------- header ---------- */\n  header{display:flex;align-items:flex-start;justify-content:space-between;padding-top:8px}\n  .car-title h1{font-size:22px;font-weight:600;letter-spacing:.2px}\n  .car-title .sub{font-size:13px;color:var(--ink-2);margin-top:3px;display:flex;align-items:center;gap:6px}\n  .dot{width:6px;height:6px;border-radius:50%;background:var(--green);display:inline-block}\n  .icon-btn{width:36px;height:36px;border-radius:50%;background:var(--card);border:1px solid var(--card-border);\n    display:flex;align-items:center;justify-content:center;color:var(--ink-2);cursor:pointer}\n  .icon-btn:active{background:var(--elev)}\n\n  /* ---------- battery line ---------- */\n  .battery-row{display:flex;align-items:center;gap:10px;margin-top:18px}\n  .batt{position:relative;width:30px;height:14px;border:1.5px solid var(--ink-2);border-radius:3.5px}\n  .batt::after{content:\"\";position:absolute;right:-4.5px;top:3.5px;width:3px;height:5px;background:var(--ink-2);border-radius:0 1.5px 1.5px 0}\n  .batt-fill{position:absolute;left:1.5px;top:1.5px;bottom:1.5px;border-radius:1.5px;background:var(--green);width:74%}\n  .batt-label{font-size:15px;font-weight:600}\n  .batt-label small{color:var(--ink-2);font-weight:400;font-size:14px;margin-left:6px}\n  .charging-bolt{color:var(--green);display:none}\n  .is-charging .charging-bolt{display:inline-flex;animation:pulse 1.6s ease-in-out infinite}\n  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}\n\n  /* ---------- sign in ---------- */\n  .signin-btn{display:block;margin:14px 0 0;background:var(--accent);color:#fff;text-align:center;\n    padding:13px;border-radius:12px;font-size:15px;font-weight:600;text-decoration:none}\n  .signin-btn:active{opacity:.85}\n  .signout{color:var(--ink-3);text-decoration:underline}\n\n  /* ---------- car ---------- */\n  .car-stage{margin:2px -8px 0;position:relative}\n  .car-stage::before{content:\"\";position:absolute;inset:-6% 4% 6% 4%;border-radius:50%;\n    background:radial-gradient(closest-side, rgba(62,106,225,.16), rgba(62,106,225,0) 72%);pointer-events:none}\n  .car-stage svg{width:100%;height:auto;display:block}\n  .car-shadow{filter:blur(14px);opacity:.5}\n\n  /* ---------- quick controls ---------- */\n  .controls{display:flex;justify-content:space-between;margin:14px 4px 6px}\n  .ctrl{display:flex;flex-direction:column;align-items:center;gap:7px;background:none;border:none;cursor:pointer;color:var(--ink);font-family:inherit}\n  .ctrl .circle{width:52px;height:52px;border-radius:50%;background:var(--card);border:1px solid var(--card-border);\n    display:flex;align-items:center;justify-content:center;color:var(--ink);transition:background .15s,color .15s,border-color .15s}\n  .ctrl span{font-size:11px;color:var(--ink-2)}\n  .ctrl.active .circle{background:var(--accent);border-color:var(--accent);color:#fff}\n  .ctrl:active .circle{background:var(--elev)}\n\n  /* ---------- stat tiles ---------- */\n  .tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:16px}\n  .tile{background:var(--card);border:1px solid var(--card-border);border-radius:14px;padding:12px 13px}\n  .tile .tl{font-size:11px;color:var(--ink-2);letter-spacing:.2px}\n  .tile .tv{font-size:19px;font-weight:600;margin-top:5px}\n  .tile .tv small{font-size:11px;font-weight:400;color:var(--ink-2);margin-left:3px}\n  .tile .td{font-size:10.5px;margin-top:4px;color:var(--ink-2)}\n  .tile .td.good{color:var(--green)}\n\n  .badge{font-size:9.5px;font-weight:700;letter-spacing:.8px;padding:2.5px 7px;border-radius:99px;\n    background:#3a3320;color:#e0b64a;border:1px solid #57492a;vertical-align:1px}\n  .badge.live{background:#1c3524;color:#4fd47a;border-color:#2a5238}\n\n  .meter-fill{overflow:hidden;position:absolute}\n  .is-charging .meter-fill::after{content:\"\";position:absolute;inset:0;\n    background:linear-gradient(100deg,transparent 30%,rgba(255,255,255,.35) 50%,transparent 70%);\n    animation:shimmer 2.2s linear infinite}\n  @keyframes shimmer{from{transform:translateX(-100%)}to{transform:translateX(100%)}}\n\n  .card,.tiles,.controls,.car-stage{animation:rise .45s ease both}\n  .card:nth-of-type(2){animation-delay:.05s}.card:nth-of-type(3){animation-delay:.1s}\n  @keyframes rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}\n  @media (prefers-reduced-motion: reduce){.card,.tiles,.controls,.car-stage{animation:none}.is-charging .meter-fill::after{animation:none}}\n\n  /* ---------- cards ---------- */\n  .card{background:var(--card);border:1px solid var(--card-border);border-radius:var(--radius);padding:18px;margin-top:14px}\n  .card-head{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:4px}\n  .card-head h2{font-size:16px;font-weight:600}\n  .card-head .meta{font-size:12.5px;color:var(--ink-2)}\n\n  /* charging card */\n  .charge-big{display:flex;align-items:baseline;gap:8px;margin-top:10px}\n  .charge-big .pct{font-size:44px;font-weight:600;letter-spacing:-.5px}\n  .charge-big .range{font-size:15px;color:var(--ink-2)}\n  .meter{position:relative;height:8px;border-radius:4px;background:var(--green-track);margin:14px 0 6px;overflow:hidden}\n  .meter-fill{position:absolute;left:0;top:0;bottom:0;background:var(--green);border-radius:4px 0 0 4px;width:74%}\n  .meter-limit{position:absolute;top:-3px;bottom:-3px;width:2px;background:var(--ink-3);left:90%}\n  .meter-scale{display:flex;justify-content:space-between;font-size:11px;color:var(--ink-3);margin-bottom:10px}\n  .charge-stats{display:flex;border-top:1px solid var(--hairline);margin-top:12px;padding-top:12px}\n  .cs{flex:1}\n  .cs + .cs{border-left:1px solid var(--hairline);padding-left:14px}\n  .cs .v{font-size:16px;font-weight:600}\n  .cs .k{font-size:11.5px;color:var(--ink-2);margin-top:3px}\n\n  /* charts */\n  .chart-wrap{position:relative;margin-top:14px}\n  .chart-wrap svg{display:block;width:100%;height:auto}\n  .chart-title{font-size:12.5px;color:var(--ink-2);margin-top:16px}\n  .tooltip{\n    position:absolute;pointer-events:none;background:#0f1216;border:1px solid #333941;border-radius:10px;\n    padding:8px 11px;font-size:12px;line-height:1.5;color:var(--ink-2);white-space:nowrap;z-index:10;\n    opacity:0;transition:opacity .1s;box-shadow:0 6px 20px rgba(0,0,0,.45)\n  }\n  .tooltip .tv{color:var(--ink);font-weight:600;font-size:13px}\n  .axis-text{font-size:10px;fill:var(--ink-3)}\n  .grid-line{stroke:#22262d;stroke-width:1}\n\n  /* climate */\n  .climate-body{display:flex;align-items:center;justify-content:space-between;margin-top:8px}\n  .temp-main{font-size:40px;font-weight:600}\n  .temp-main small{font-size:16px;color:var(--ink-2);font-weight:400}\n  .temp-sub{font-size:13px;color:var(--ink-2);margin-top:2px}\n  .temp-ctrl{display:flex;align-items:center;gap:14px}\n  .temp-btn{width:40px;height:40px;border-radius:50%;background:var(--elev);border:none;color:var(--ink);\n    font-size:20px;cursor:pointer;font-family:inherit}\n  .temp-set{font-size:17px;font-weight:600;min-width:44px;text-align:center}\n\n  /* location */\n  #liveMap{height:180px;border-radius:12px;border:1px solid var(--card-border);z-index:0}\n  .leaflet-container{background:#20242b;font:inherit}\n  .sc-row{display:flex;justify-content:space-between;align-items:center;padding:11px 0;border-bottom:1px solid var(--hairline);font-size:13.5px}\n  .sc-row:last-child{border-bottom:none;padding-bottom:0}\n  .sc-name{max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n  .sc-stat{font-weight:600}\n  .sc-stat small{color:var(--ink-2);font-weight:400;margin-left:6px}\n  .sc-good{color:var(--green)}.sc-mid{color:#e0b64a}.sc-low{color:var(--red)}\n  .map{border-radius:12px;overflow:hidden;margin-top:12px;position:relative;border:1px solid var(--card-border)}\n  .map svg{display:block;width:100%;height:auto}\n  .loc-line{display:flex;align-items:center;gap:8px;margin-top:12px;font-size:13.5px;color:var(--ink-2)}\n  .loc-line svg{flex:none}\n\n  /* info rows */\n  .rows{margin-top:6px}\n  .row{display:flex;justify-content:space-between;align-items:center;padding:12px 0;border-bottom:1px solid var(--hairline);font-size:14px}\n  .row:last-child{border-bottom:none;padding-bottom:0}\n  .row .k{color:var(--ink-2)}\n  .row .v{font-weight:500}\n\n  /* footer */\n  .demo-note{margin-top:22px;text-align:center;font-size:12px;color:var(--ink-3);line-height:1.6}\n  .demo-note b{color:var(--ink-2);font-weight:600}\n</style>\n</head>\n<body>\n<div id=\"boot\" style=\"position:fixed;inset:0;background:var(--bg);display:flex;align-items:center;justify-content:center;z-index:99\">\n  <div style=\"width:34px;height:34px;border:3px solid #262b33;border-top-color:#3e6ae1;border-radius:50%;animation:bspin 1s linear infinite\"></div>\n</div>\n<style>@keyframes bspin{to{transform:rotate(360deg)}}</style>\n<div class=\"app\" id=\"app\">\n\n  <header>\n    <div class=\"car-title\">\n      <h1 id=\"carName\">Steve's Model Y</h1>\n      <div class=\"sub\"><span class=\"dot\" id=\"statusDot\"></span><span id=\"statusText\">Charging \u00b7 Home</span>&nbsp;<span class=\"badge\" id=\"srcBadge\">DEMO</span></div>\n    </div>\n    <div class=\"icon-btn\" title=\"Account\">\n      <svg width=\"17\" height=\"17\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\"><circle cx=\"12\" cy=\"8\" r=\"4\"/><path d=\"M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5\"/></svg>\n    </div>\n  </header>\n\n  <div class=\"battery-row is-charging\" id=\"batteryRow\">\n    <div class=\"batt\"><div class=\"batt-fill\" id=\"battFill\"></div></div>\n    <div class=\"batt-label\"><span id=\"battPct\">74%</span><small id=\"battRange\">243 mi</small></div>\n    <span class=\"charging-bolt\">\n      <svg width=\"13\" height=\"13\" viewBox=\"0 0 24 24\" fill=\"currentColor\"><path d=\"M13 2 4 14h6l-1 8 9-12h-6l1-8z\"/></svg>\n    </span>\n  </div>\n\n  <a class=\"signin-btn\" id=\"signinBtn\" href=\"/auth/login\" style=\"display:none\">Sign in with Tesla</a>\n\n  <div class=\"car-stage\" id=\"carStage\"><!-- car SVG injected by JS --></div>\n\n  <div class=\"controls\">\n    <button class=\"ctrl active\" id=\"ctrlLock\" data-label-on=\"Locked\" data-label-off=\"Unlocked\">\n      <div class=\"circle\">\n        <svg width=\"21\" height=\"21\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"4.5\" y=\"10.5\" width=\"15\" height=\"10\" rx=\"2.5\"/><path class=\"lock-shackle\" d=\"M8 10.5V7a4 4 0 0 1 8 0v3.5\"/></svg>\n      </div><span>Locked</span>\n    </button>\n    <button class=\"ctrl\" id=\"ctrlClimate\">\n      <div class=\"circle\">\n        <svg width=\"21\" height=\"21\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\"><path d=\"M12 3v18M5.5 6.5 12 10l6.5-3.5M5.5 17.5 12 14l6.5 3.5\"/></svg>\n      </div><span>Climate</span>\n    </button>\n    <button class=\"ctrl active\" id=\"ctrlPort\">\n      <div class=\"circle\">\n        <svg width=\"21\" height=\"21\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M13 2 5 13h6l-1 9 8-11h-6l1-9z\"/></svg>\n      </div><span>Charge Port</span>\n    </button>\n    <button class=\"ctrl\" id=\"ctrlFrunk\">\n      <div class=\"circle\">\n        <svg width=\"21\" height=\"21\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M3 15h18M3 15c0-3 4-8 9-8s9 5 9 8M12 7V5\"/></svg>\n      </div><span>Frunk</span>\n    </button>\n    <button class=\"ctrl\" id=\"ctrlTrunk\">\n      <div class=\"circle\">\n        <svg width=\"21\" height=\"21\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M21 15H3M21 15c0-3-4-8-9-8M12 7c-2 0-4 .8-5.5 2M12 7V5\"/></svg>\n      </div><span>Trunk</span>\n    </button>\n  </div>\n\n  <div class=\"tiles\">\n    <div class=\"tile\"><div class=\"tl\">Efficiency \u00b7 7d</div><div class=\"tv\" id=\"tileEff\">263<small>Wh/mi</small></div><div class=\"td good\" id=\"tileEffD\">\u25bc 4% vs prior week</div></div>\n    <div class=\"tile\"><div class=\"tl\">Driven \u00b7 7d</div><div class=\"tv\" id=\"tileMi\">186<small>mi</small></div><div class=\"td\" id=\"tileMiD\">\u25b2 12% vs prior week</div></div>\n    <div class=\"tile\"><div class=\"tl\">Charge cost \u00b7 Aug</div><div class=\"tv\" id=\"tileCost\">$11.40</div><div class=\"td\" id=\"tileCostD\">92% at home</div></div>\n  </div>\n\n  <!-- Charging -->\n  <section class=\"card\" id=\"chargingCard\">\n    <div class=\"card-head\"><h2>Charging</h2><div class=\"meta\" id=\"chargeMeta\">32 min until limit</div></div>\n    <div class=\"charge-big\"><div class=\"pct\" id=\"chargePct\">74%</div><div class=\"range\" id=\"chargeRange\">243 mi</div></div>\n    <div class=\"meter is-charging\" id=\"meterWrap\"><div class=\"meter-fill\" id=\"meterFill\"></div><div class=\"meter-limit\" id=\"meterLimit\"></div></div>\n    <div class=\"meter-scale\"><span>0%</span><span id=\"limitLabel\">Limit 90%</span><span>100%</span></div>\n    <div class=\"charge-stats\">\n      <div class=\"cs\"><div class=\"v\" id=\"csPower\">7.4 kW</div><div class=\"k\">Charge rate</div></div>\n      <div class=\"cs\"><div class=\"v\" id=\"csAmps\">32 A \u00b7 240 V</div><div class=\"k\">Current session</div></div>\n      <div class=\"cs\"><div class=\"v\" id=\"csAdded\">+18.2 kWh</div><div class=\"k\">Energy added</div></div>\n    </div>\n    <div class=\"chart-title\">Tonight's charge session</div>\n    <div class=\"chart-wrap\" id=\"chargeChartWrap\">\n      <svg id=\"chargeChart\" viewBox=\"0 0 360 130\" role=\"img\" aria-label=\"Charge level over tonight's session, 42 to 74 percent\"></svg>\n      <div class=\"tooltip\" id=\"chargeTip\"></div>\n    </div>\n  </section>\n\n  <!-- Climate -->\n  <section class=\"card\">\n    <div class=\"card-head\"><h2>Climate</h2><div class=\"meta\" id=\"climateMeta\">Off</div></div>\n    <div class=\"climate-body\">\n      <div>\n        <div class=\"temp-main\" id=\"tempIn\">71<small>\u00b0F inside</small></div>\n        <div class=\"temp-sub\" id=\"tempOut\">64\u00b0F outside</div>\n      </div>\n      <div class=\"temp-ctrl\">\n        <button class=\"temp-btn\" id=\"tempDown\">\u2212</button>\n        <div class=\"temp-set\" id=\"tempSet\">70\u00b0</div>\n        <button class=\"temp-btn\" id=\"tempUp\">+</button>\n      </div>\n    </div>\n  </section>\n\n  <!-- Location -->\n  <section class=\"card\">\n    <div class=\"card-head\"><h2>Location</h2><div class=\"meta\">Parked \u00b7 Home</div></div>\n    <div class=\"map\" id=\"mapWrap\"><div id=\"liveMap\"></div></div>\n    <div class=\"loc-line\">\n      <svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\"><path d=\"M12 21s-7-5.5-7-11a7 7 0 0 1 14 0c0 5.5-7 11-7 11z\"/><circle cx=\"12\" cy=\"10\" r=\"2.5\"/></svg>\n      <span id=\"address\">2882 Sand Hill Rd, Menlo Park, CA</span>\n    </div>\n  </section>\n\n  <!-- Superchargers -->\n  <section class=\"card\">\n    <div class=\"card-head\"><h2>Superchargers</h2><div class=\"meta\" id=\"scMeta\">Nearby</div></div>\n    <div class=\"rows\" id=\"scRows\"></div>\n  </section>\n\n  <!-- Last 7 days -->\n  <section class=\"card\">\n    <div class=\"card-head\"><h2>Last 7 days</h2><div class=\"meta\" id=\"weekMeta\">186 mi driven</div></div>\n    <div class=\"chart-wrap\" id=\"weekChartWrap\">\n      <svg id=\"weekChart\" viewBox=\"0 0 360 140\" role=\"img\" aria-label=\"Miles driven per day over the last seven days\"></svg>\n      <div class=\"tooltip\" id=\"weekTip\"></div>\n    </div>\n  </section>\n\n  <!-- Specs -->\n  <section class=\"card\">\n    <div class=\"card-head\"><h2>Specs</h2><div class=\"meta\">From Tesla</div></div>\n    <div class=\"rows\">\n      <div class=\"row\"><span class=\"k\">Model</span><span class=\"v\" id=\"specModel\">Model Y</span></div>\n      <div class=\"row\"><span class=\"k\">Trim</span><span class=\"v\" id=\"specTrim\">\u2014</span></div>\n      <div class=\"row\"><span class=\"k\">Paint</span><span class=\"v\" id=\"specPaint\">\u2014</span></div>\n      <div class=\"row\"><span class=\"k\">Wheels</span><span class=\"v\" id=\"specWheels\">\u2014</span></div>\n      <div class=\"row\"><span class=\"k\">Roof \u00b7 Trim</span><span class=\"v\" id=\"specExtra\">\u2014</span></div>\n    </div>\n  </section>\n\n  <!-- Vehicle -->\n  <section class=\"card\">\n    <div class=\"card-head\"><h2>Vehicle</h2></div>\n    <div class=\"rows\">\n      <div class=\"row\"><span class=\"k\">Odometer</span><span class=\"v\" id=\"rowOdo\">18,443 mi</span></div>\n      <div class=\"row\"><span class=\"k\">Software</span><span class=\"v\" id=\"rowSoftware\">2026.20.4</span></div>\n      <div class=\"row\"><span class=\"k\">Sentry Mode</span><span class=\"v\" id=\"rowSentry\">Off</span></div>\n      <div class=\"row\"><span class=\"k\">Doors \u00b7 Windows</span><span class=\"v\" id=\"rowDoors\">Closed</span></div>\n      <div class=\"row\"><span class=\"k\">Efficiency (7 days)</span><span class=\"v\">263 Wh/mi</span></div>\n      <div class=\"row\"><span class=\"k\">Tire pressure</span><span class=\"v\" id=\"rowTires\">42 \u00b7 42 \u00b7 41 \u00b7 42 psi</span></div>\n      <div class=\"row\"><span class=\"k\">Interior \u00b7 Cabin overheat</span><span class=\"v\">On</span></div>\n    </div>\n  </section>\n\n  <div class=\"demo-note\" id=\"demoNote\">\n    <b id=\"footNote\">Demo data.</b><br>\n    <span id=\"footHint\">Tap \"Sign in with Tesla\" above to see your own car.</span>\n    <a class=\"signout\" id=\"deviceLink\" href=\"#\" style=\"display:none\">Use on another device</a> \u00b7 <span style=\"opacity:.35\">v15</span> <a class=\"signout\" id=\"signoutLink\" href=\"/auth/logout\" style=\"display:none\"\n      onclick=\"try{localStorage.removeItem('bem_rt')}catch(e){}\">Sign out</a>\n  </div>\n\n</div>\n<script>\n\"use strict\";\n\n/* =====================================================================\n   DATA LAYER \u2014 swap this for your Tesla Fleet API proxy to go live.\n   The shape mirrors Fleet API's /api/1/vehicles/{id}/vehicle_data.\n   ===================================================================== */\nconst DEMO_DATA = {\n  display_name: \"Steve's Model Y\",\n  state: \"online\",\n  charge_state: {\n    charging_state: \"Charging\",          // \"Charging\" | \"Stopped\" | \"Disconnected\"\n    battery_level: 74,                    // %\n    battery_range: 243,                   // mi\n    charge_limit_soc: 90,                 // %\n    charger_power: 7.4,                   // kW\n    charger_actual_current: 32,           // A\n    charger_voltage: 240,                 // V\n    charge_energy_added: 18.2,            // kWh\n    minutes_to_full_charge: 32,\n    session: [                            // [minutes since 20:30, battery %]\n      [0,42],[15,45],[30,48],[45,51],[60,54],[75,57],[90,60],\n      [105,62],[120,65],[135,67],[150,69],[165,71],[180,73],[195,74]\n    ]\n  },\n  climate_state: {\n    inside_temp_f: 71, outside_temp_f: 64,\n    driver_temp_setting_f: 70, is_climate_on: false\n  },\n  drive_state: { shift_state: null, latitude: 37.4419, longitude: -122.1806, speed: null,\n    address: \"2882 Sand Hill Rd, Menlo Park, CA\" },\n  vehicle_config: { car_type: \"modely\", exterior_color: \"PearlWhite\", wheel_type: \"Gemini19\",\n    trim_badging: \"74d\", roof_color: \"RoofColorGlass\", spoiler_type: \"None\", exterior_trim: \"Black\" },\n  vehicle_state: {\n    odometer: 18443, car_version: \"2026.20.4\", locked: true,\n    tpms: [42,42,41,42], sentry_mode: false, doors_open: false, windows_open: false,\n    update_status: \"\", update_version: \"\"\n  },\n  week: [                                 // last 7 days of driving\n    {day:\"Fri\", mi:12},{day:\"Sat\", mi:41},{day:\"Sun\", mi:8},{day:\"Mon\", mi:26},\n    {day:\"Tue\", mi:31},{day:\"Wed\", mi:19},{day:\"Thu\", mi:49}\n  ]\n};\n\nlet DATA_SOURCE = \"demo\";\nlet LAST_ERROR = \"\";\nfunction authHeaders(){\n  try{ const t = localStorage.getItem(\"bem_rt\"); return t ? { \"x-bem-rt\": t } : {}; }catch(e){ return {}; }\n}\nfunction noteRotation(r){\n  try{ const n = r.headers.get(\"x-bem-rt-new\"); if (n) localStorage.setItem(\"bem_rt\", n); }catch(e){}\n}\nasync function getVehicleData(){\n  /* The bundled server (server.js) exposes /api/vehicle. Until you add your\n     Tesla Fleet API credentials as environment variables on the server, it\n     answers {demo:true} and this dashboard runs on the demo dataset. */\n  try{\n    const r = await fetch(\"/api/vehicle\", {cache:\"no-store\", headers: authHeaders()});\n    if (r.ok){\n      noteRotation(r);\n      const j = await r.json();\n      if (j.signed_in && j.no_vehicles){ DATA_SOURCE = \"wrongaccount\"; return null; }\n      if (j.signed_in && (j.asleep || j.error)){ DATA_SOURCE = \"asleep\"; LAST_ERROR = j.error || \"\"; return null; }\n      if (!j.demo){ DATA_SOURCE = \"live\"; return j; }\n    }\n  }catch(e){ /* file:// or offline -> demo */ }\n  DATA_SOURCE = \"demo\";\n  return DEMO_DATA;\n}\n\n/* ============================ CAR RENDER ============================ */\n/* Tesla's own configurator render \u2014 the same imagery the Tesla app uses.\n   Color + wheels come from your vehicle_config, so it looks like YOUR car.\n   Falls back to the built-in SVG if the image can't load. */\nconst MODEL_SLUG = { modely:\"my\", model3:\"m3\", models:\"ms\", modelx:\"mx\" };\nconst COLOR_CODES = {\n  PearlWhite:\"$PPSW\", White:\"$PPSW\", SolidBlack:\"$PBSB\", Black:\"$PBSB\",\n  DiamondBlack:\"$PBSB\", MidnightSilver:\"$PMNG\", Silver:\"$PMNG\", SteelGrey:\"$PMNG\",\n  DeepBlue:\"$PPSB\", DeepBlueMetallic:\"$PPSB\", Blue:\"$PPSB\",\n  RedMulticoat:\"$PPMR\", Red:\"$PPMR\", UltraRed:\"$PR01\",\n  Quicksilver:\"$PN01\", StealthGrey:\"$PN00\", Grey:\"$PN00\", Gray:\"$PN00\",\n  GlacierBlue:\"$PB01\", MidnightCherryRed:\"$PR00\"\n};\nconst WHEEL_CODES = {\n  Gemini19:\"$WY19B\", GeminiWheels19:\"$WY19B\", Apollo19:\"$WY19B\",\n  Photon19:\"$WY19C\", Crossflow19:\"$WY19P\", Helix19:\"$WY19D\",\n  Induction20:\"$WY20P\", InductionWheels20:\"$WY20P\", Crossflow20:\"$WY20A\",\n  HelixV220:\"$WY20J\", Helix220:\"$WY20J\", Helix20:\"$WY20J\"\n};\nconst MODEL_DESIGNATOR = { my:\"$MDLY\", m3:\"$MDL3\", ms:\"$MDLS\", mx:\"$MDLX\" };\nconst TRIM_CODES = [\"$MTY13\",\"$MTY14\",\"$MTY12\",\"$MTY11\",\"$MTY07\",\"$MTY01\"];\n\n/* Tesla's render service at /v1/compositor/. An option string it doesn't\n   understand yields an EMPTY stage (shadow, no car) rather than an error, so\n   every candidate is pixel-checked before it is allowed on screen. */\nfunction carImageCandidates(cfg){\n  cfg = cfg || {};\n  const model = MODEL_SLUG[cfg.car_type] || \"my\";\n  const color = COLOR_CODES[cfg.exterior_color] || \"$PPSW\";\n  const wheel = WHEEL_CODES[cfg.wheel_type] || \"\";\n  const MDL = MODEL_DESIGNATOR[model] || \"$MDLY\";\n  const V1 = \"https://static-assets.tesla.com/v1/compositor/\";\n  const mk = (opts, view) => V1 + \"?model=\" + model + \"&view=\" + view +\n    \"&size=1200&options=\" + encodeURIComponent(opts) + \"&bkba_opt=2&crop=0,0,0,0\";\n  const wheels = wheel ? [wheel, \"$WY19B\", \"$WY20P\"] : [\"$WY19B\", \"$WY20P\"];\n  const out = [];\n  [\"STUD_3QTR\", \"STUD_SIDE\"].forEach(v => {\n    TRIM_CODES.forEach(t => wheels.slice(0, 2).forEach(w => out.push(mk([MDL, t, color, w].join(\",\"), v))));\n    wheels.forEach(w => out.push(mk([MDL, color, w].join(\",\"), v)));\n    out.push(mk([MDL, color].join(\",\"), v));\n    out.push(mk(color, v));\n  });\n  return out;\n}\n\n/* Load a candidate and decide whether it actually contains a car. */\nfunction testCarImage(url){\n  return new Promise(resolve => {\n    const img = new Image();\n    img.crossOrigin = \"anonymous\";\n    let settled = false;\n    const done = (r) => { if (!settled){ settled = true; resolve(r); } };\n    img.onload = () => {\n      if (img.naturalWidth < 300) return done({ url, ok:false, why:\"tiny\" });\n      try {\n        const W = 150, H = 90;\n        const c = document.createElement(\"canvas\");\n        c.width = W; c.height = H;\n        const ctx = c.getContext(\"2d\");\n        ctx.drawImage(img, 0, 0, W, H);\n        const d = ctx.getImageData(0, 0, W, H).data;\n        let solid = 0;\n        for (let p = 3; p < d.length; p += 4) if (d[p] > 60) solid++;\n        const frac = solid / (W * H);\n        return done({ url, ok: frac > 0.10, frac: Math.round(frac * 100), img, why: \"px\" });\n      } catch (e) {\n        // canvas tainted (no CORS header) - can't inspect, accept cautiously\n        return done({ url, ok: true, img, why: \"tainted\" });\n      }\n    };\n    img.onerror = () => done({ url, ok:false, why:\"error\" });\n    img.src = url;\n    setTimeout(() => done({ url, ok:false, why:\"timeout\" }), 9000);\n  });\n}\nasync function mountCarImage(cfg){\n  const stage = document.getElementById(\"carStage\");\n  stage.innerHTML = carSVG();                       // drawn car stays unless a real render wins\n  const debug = /[?&]debug=1/.test(location.search);\n  const urls = carImageCandidates(cfg);\n  let results = [];\n  try { results = await Promise.all(urls.map(testCarImage)); } catch (e) {}\n  const hit = results.find(r => r && r.ok && r.img);\n  if (hit){\n    hit.img.alt = \"Your car\";\n    hit.img.style.cssText = \"width:100%;display:block;filter:drop-shadow(0 20px 18px rgba(0,0,0,.45))\";\n    stage.innerHTML = \"\";\n    stage.appendChild(hit.img);\n    console.log(\"car render OK:\", hit.url);\n  }\n  if (debug){\n    const box = document.createElement(\"div\");\n    box.style.cssText = \"font:10.5px/1.5 ui-monospace,monospace;color:#9b9fa5;background:#1c2027;border:1px solid #262b33;border-radius:10px;padding:10px;margin:10px 0;word-break:break-all\";\n    const lines = results.map(r => {\n      const o = decodeURIComponent((r.url.match(/options=([^&]*)/) || [])[1] || \"\");\n      const v = (r.url.match(/view=([^&]*)/) || [])[1] || \"\";\n      return (r.ok ? \"OK  \" : \"--  \") + v + \" \" + o + \"  [\" + r.why + (r.frac != null ? \" \" + r.frac + \"%\" : \"\") + \"]\";\n    });\n    box.textContent = \"CAR RENDER DEBUG (v15)\\n\" + lines.join(\"\\n\");\n    box.style.whiteSpace = \"pre-wrap\";\n    stage.parentNode.insertBefore(box, stage.nextSibling);\n  }\n}\n\n/* ==================== LIVE MAP & SUPERCHARGERS ====================== */\nlet liveMap = null, liveMarker = null;\nfunction renderMap(ds){\n  const el = document.getElementById(\"liveMap\");\n  const lat = ds.latitude, lon = ds.longitude;\n  if (!el || typeof L === \"undefined\" || lat == null || lon == null){\n    // fallback: stylized static map\n    document.getElementById(\"mapWrap\").innerHTML = mapSVG();\n    return;\n  }\n  el.style.display = \"block\";\n  if (!liveMap){\n    liveMap = L.map(\"liveMap\", { zoomControl:false, attributionControl:false, dragging:true, scrollWheelZoom:false });\n    L.tileLayer(\"https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png\", { maxZoom: 19 }).addTo(liveMap);\n  }\n  liveMap.setView([lat, lon], 15);\n  if (liveMarker) liveMarker.remove();\n  liveMarker = L.circleMarker([lat, lon], { radius:8, color:\"#fff\", weight:2.5, fillColor:\"#3e6ae1\", fillOpacity:1 }).addTo(liveMap);\n  // reverse geocode for a human address (best-effort)\n  fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}`)\n    .then(r => r.json())\n    .then(j => {\n      const a = j.address || {};\n      const line = [a.house_number, a.road].filter(Boolean).join(\" \");\n      const town = a.city || a.town || a.village || a.hamlet || \"\";\n      const txt = [line, town, a.state].filter(Boolean).join(\", \");\n      if (txt) document.getElementById(\"address\").textContent = txt;\n    }).catch(()=>{});\n}\n\nconst DEMO_CHARGERS = [\n  { name: \"Menlo Park, CA\", distance_miles: 1.2, available_stalls: 9, total_stalls: 12 },\n  { name: \"Palo Alto - Stanford\", distance_miles: 2.8, available_stalls: 4, total_stalls: 16 },\n  { name: \"Redwood City, CA\", distance_miles: 4.1, available_stalls: 11, total_stalls: 20 }\n];\nasync function renderChargers(){\n  let list = DEMO_CHARGERS;\n  try{\n    const r = await fetch(\"/api/chargers\", { cache: \"no-store\", headers: authHeaders() });\n    if (r.ok){ const j = await r.json(); if (j.superchargers && j.superchargers.length) list = j.superchargers; }\n  }catch(e){}\n  const wrap = document.getElementById(\"scRows\");\n  wrap.textContent = \"\";\n  list.slice(0, 5).forEach(c => {\n    const row = document.createElement(\"div\"); row.className = \"sc-row\";\n    const name = document.createElement(\"div\"); name.className = \"sc-name\"; name.textContent = c.name;\n    const stat = document.createElement(\"div\"); stat.className = \"sc-stat\";\n    if (c.available_stalls != null && c.total_stalls != null){\n      const frac = c.total_stalls ? c.available_stalls / c.total_stalls : 0;\n      const cls = frac > 0.4 ? \"sc-good\" : (frac > 0.15 ? \"sc-mid\" : \"sc-low\");\n      const strong = document.createElement(\"span\"); strong.className = cls;\n      strong.textContent = `${c.available_stalls}/${c.total_stalls}`;\n      stat.appendChild(strong);\n    }\n    const dist = document.createElement(\"small\"); dist.textContent = `${c.distance_miles} mi`;\n    stat.appendChild(dist);\n    row.append(name, stat); wrap.appendChild(row);\n  });\n}\n\n/* ============================ RENDER ================================ */\nfunction render(data){\n  const cs = data.charge_state, cl = data.climate_state, vs = data.vehicle_state;\n  const set = (id,txt)=>{ document.getElementById(id).textContent = txt; };\n\n  set(\"carName\", data.display_name);\n  const badge = document.getElementById(\"srcBadge\");\n  const live = DATA_SOURCE === \"live\";\n  badge.textContent = live ? \"LIVE\" : \"DEMO\";\n  badge.classList.toggle(\"live\", live);\n  document.getElementById(\"signinBtn\").style.display = live ? \"none\" : \"block\";\n  document.getElementById(\"footNote\").textContent = live ? \"Connected to your Tesla.\" : \"Demo data.\";\n  document.getElementById(\"footHint\").style.display = live ? \"none\" : \"inline\";\n  document.getElementById(\"signoutLink\").style.display = live ? \"inline\" : \"none\";\n  document.getElementById(\"deviceLink\").style.display = live ? \"inline\" : \"none\";\n  const charging = cs.charging_state === \"Charging\";\n  set(\"statusText\", charging ? \"Charging \u00b7 Home\" : \"Parked \u00b7 Home\");\n  document.getElementById(\"batteryRow\").classList.toggle(\"is-charging\", charging);\n\n  set(\"battPct\", cs.battery_level + \"%\");\n  set(\"battRange\", cs.battery_range + \" mi\");\n  document.getElementById(\"battFill\").style.width = cs.battery_level + \"%\";\n  document.getElementById(\"battFill\").style.background =\n    cs.battery_level <= 20 ? \"var(--red)\" : \"var(--green)\";\n\n  set(\"chargePct\", cs.battery_level + \"%\");\n  set(\"chargeRange\", cs.battery_range + \" mi\");\n  set(\"chargeMeta\", charging ? cs.minutes_to_full_charge + \" min until limit\" : \"Plugged in\");\n  document.getElementById(\"meterFill\").style.width = cs.battery_level + \"%\";\n  document.getElementById(\"meterLimit\").style.left = cs.charge_limit_soc + \"%\";\n  set(\"limitLabel\", \"Limit \" + cs.charge_limit_soc + \"%\");\n  set(\"csPower\", cs.charger_power.toFixed(1) + \" kW\");\n  set(\"csAmps\", cs.charger_actual_current + \" A \u00b7 \" + cs.charger_voltage + \" V\");\n  set(\"csAdded\", \"+\" + cs.charge_energy_added.toFixed(1) + \" kWh\");\n\n  document.getElementById(\"tempIn\").childNodes[0].textContent = cl.inside_temp_f;\n  set(\"tempOut\", cl.outside_temp_f + \"\u00b0F outside\");\n  set(\"tempSet\", cl.driver_temp_setting_f + \"\u00b0\");\n  set(\"climateMeta\", cl.is_climate_on ? \"Keeping \" + cl.driver_temp_setting_f + \"\u00b0\" : \"Off\");\n\n  if (data.drive_state.address) set(\"address\", data.drive_state.address);\n  else set(\"address\", \"Locating\u2026\");\n  renderMap(data.drive_state);\n  renderChargers();\n\n  set(\"rowOdo\", vs.odometer.toLocaleString() + \" mi\");\n  set(\"rowSoftware\", vs.update_status\n    ? (vs.car_version + \" \u2192 \" + (vs.update_version || \"update\") + \" \" + vs.update_status)\n    : vs.car_version + \" \u00b7 Up to date\");\n  set(\"rowSentry\", vs.sentry_mode ? \"On\" : \"Off\");\n  set(\"rowDoors\", (vs.doors_open || vs.windows_open)\n    ? [(vs.doors_open ? \"Door open\" : null), (vs.windows_open ? \"Window open\" : null)].filter(Boolean).join(\" \u00b7 \")\n    : \"Closed\");\n  if (vs.tpms && vs.tpms.some(p => p != null))\n    set(\"rowTires\", vs.tpms.map(p => p ?? \"\u2013\").join(\" \u00b7 \") + \" psi\");\n\n  const wk = data.week || [];\n  set(\"weekMeta\", wk.length ? wk.reduce((s,d)=>s+d.mi,0) + \" mi driven\" : \"Sample data\");\n\n  mountCarImage(data.vehicle_config);\n  const vc = data.vehicle_config || {};\n  const nice = x => x ? String(x).replace(/([a-z])([A-Z])/g, \"$1 $2\") : \"\u2014\";\n  set(\"specModel\", ({modely:\"Model Y\", model3:\"Model 3\", models:\"Model S\", modelx:\"Model X\"})[vc.car_type] || vc.car_type || \"\u2014\");\n  set(\"specTrim\", vc.trim_badging ? String(vc.trim_badging).toUpperCase() : \"\u2014\");\n  set(\"specPaint\", nice(vc.exterior_color));\n  set(\"specWheels\", nice(vc.wheel_type));\n  set(\"specExtra\", [nice(vc.roof_color), nice(vc.exterior_trim)].filter(x=>x!==\"\u2014\").join(\" \u00b7 \") || \"\u2014\");\n  renderChargeChart(data);\n  renderWeekChart(data);\n}\n\nasync function shareDeviceLink(ev){\n  ev.preventDefault();\n  try{\n    const r = await fetch(\"/auth/handoff-link\", { headers: authHeaders() });\n    if (!r.ok) { alert(\"Sign in first, then try again.\"); return; }\n    const j = await r.json();\n    if (navigator.share) { await navigator.share({ title: \"My car dashboard\", url: j.url }); }\n    else if (navigator.clipboard) { await navigator.clipboard.writeText(j.url); alert(\"Link copied! Open it in the other browser. Treat it like a key - it grants access to your car data.\"); }\n    else { prompt(\"Copy this link and open it in the other browser:\", j.url); }\n  }catch(e){ alert(\"Could not create link: \" + e.message); }\n}\ndocument.addEventListener(\"DOMContentLoaded\", () => {\n  const dl = document.getElementById(\"deviceLink\");\n  if (dl) dl.addEventListener(\"click\", shareDeviceLink);\n});\n\n/* ========================= INTERACTIONS ============================= */\nfunction wireControls(data){\n  const lock = document.getElementById(\"ctrlLock\");\n  lock.addEventListener(\"click\", ()=>{\n    const on = lock.classList.toggle(\"active\");\n    lock.querySelector(\"span\").textContent = on ? \"Locked\" : \"Unlocked\";\n  });\n  const climate = document.getElementById(\"ctrlClimate\");\n  climate.addEventListener(\"click\", ()=>{\n    const on = climate.classList.toggle(\"active\");\n    data.climate_state.is_climate_on = on;\n    document.getElementById(\"climateMeta\").textContent =\n      on ? \"Keeping \" + data.climate_state.driver_temp_setting_f + \"\u00b0\" : \"Off\";\n  });\n  [\"ctrlPort\",\"ctrlFrunk\",\"ctrlTrunk\"].forEach(id=>{\n    const b = document.getElementById(id);\n    b.addEventListener(\"click\", ()=> b.classList.toggle(\"active\"));\n  });\n  const setEl = document.getElementById(\"tempSet\");\n  document.getElementById(\"tempUp\").addEventListener(\"click\", ()=>{\n    data.climate_state.driver_temp_setting_f = Math.min(82, data.climate_state.driver_temp_setting_f+1);\n    setEl.textContent = data.climate_state.driver_temp_setting_f + \"\u00b0\";\n  });\n  document.getElementById(\"tempDown\").addEventListener(\"click\", ()=>{\n    data.climate_state.driver_temp_setting_f = Math.max(59, data.climate_state.driver_temp_setting_f-1);\n    setEl.textContent = data.climate_state.driver_temp_setting_f + \"\u00b0\";\n  });\n}\n\n/* ============================== BOOT ================================ */\nfunction showLanding(){\n  const app = document.getElementById(\"app\");\n  app.innerHTML = `\n    <div style=\"min-height:86vh;display:flex;flex-direction:column;justify-content:center;text-align:center\">\n      <h1 style=\"font-size:26px;font-weight:600;letter-spacing:.3px\">Buddy EV Monitor</h1>\n      <p style=\"color:var(--ink-2);font-size:14px;margin-top:8px\">Your Tesla, live in your browser.</p>\n      <div class=\"car-stage\" style=\"margin:10px -8px\">${carSVG()}</div>\n      <a class=\"signin-btn\" href=\"/auth/login\" style=\"display:block\">Sign in with Tesla</a>\n      <p style=\"color:var(--ink-3);font-size:12px;margin-top:18px;line-height:1.6\">\n        Sign in with your Tesla account to see your car.<br>\n        Nothing is shown until you do. <span style=\"opacity:.5\">v15</span></p>\n    </div>`;\n}\n\nfunction showWrongAccount(){\n  const app = document.getElementById(\"app\");\n  app.innerHTML = `\n    <div style=\"min-height:86vh;display:flex;flex-direction:column;justify-content:center;text-align:center\">\n      <h1 style=\"font-size:23px;font-weight:600\">Wrong Tesla account</h1>\n      <p style=\"color:var(--ink-2);font-size:14px;margin-top:10px;line-height:1.65\">\n        You're signed in &mdash; but this Tesla account has no cars on it.<br>\n        The browser signed you in with a different Tesla login<br>than the one your car lives on.</p>\n      <div class=\"car-stage\" style=\"margin:14px -8px;opacity:.4\">${carSVG()}</div>\n      <a class=\"signin-btn\" href=\"/auth/logout\" onclick=\"try{localStorage.removeItem('bem_rt')}catch(e){}\">Sign out and try again</a>\n      <p style=\"color:var(--ink-3);font-size:12px;margin-top:16px;line-height:1.6\">\n        Tip: sign out at tesla.com in this browser first, so Tesla<br>\n        asks which account to use. <span style=\"opacity:.5\">v15</span></p>\n    </div>`;\n}\n\nfunction showAsleep(){\n  const app = document.getElementById(\"app\");\n  app.innerHTML = `\n    <div style=\"min-height:86vh;display:flex;flex-direction:column;justify-content:center;text-align:center\">\n      <h1 style=\"font-size:24px;font-weight:600\">Your car is sleeping &#128564;</h1>\n      <p style=\"color:var(--ink-2);font-size:14px;margin-top:8px;line-height:1.6\">\n        You're signed in, but the car is napping to save battery.<br>Wake it to load the dashboard.</p>\n      <div class=\"car-stage\" style=\"margin:10px -8px;opacity:.55\">${carSVG()}</div>\n      <a class=\"signin-btn\" id=\"wakeBtn\" href=\"#\" style=\"display:block\">Wake up car</a>\n      <p id=\"wakeStatus\" style=\"color:var(--ink-3);font-size:12.5px;margin-top:16px\"></p>\n      <p style=\"color:var(--ink-3);font-size:11.5px;margin-top:10px\">\n        <a class=\"signout\" href=\"/auth/logout\" onclick=\"try{localStorage.removeItem('bem_rt')}catch(e){}\">Sign out</a>\n        \u00b7 <span style=\"opacity:.5\">v15</span></p>\n    </div>`;\n  document.getElementById(\"wakeBtn\").addEventListener(\"click\", async (ev) => {\n    ev.preventDefault();\n    const btn = document.getElementById(\"wakeBtn\"), st = document.getElementById(\"wakeStatus\");\n    btn.style.opacity = \".5\"; btn.style.pointerEvents = \"none\";\n    st.textContent = \"Sending wake-up call\u2026\";\n    let wakeOk = false;\n    try {\n      const wr = await fetch(\"/api/wake\", { method: \"POST\", headers: authHeaders() });\n      const wj = await wr.json();\n      wakeOk = !!wj.ok;\n      if (!wj.ok && (wj.status === 403 || wj.status === 401)){\n        st.textContent = \"Permission update needed: tap Sign out below, then sign in again to grant wake access.\";\n        btn.style.opacity = \"1\"; btn.style.pointerEvents = \"auto\";\n        return;\n      }\n    } catch(e) {}\n    for (let i = 1; i <= 12; i++){\n      st.textContent = \"Waking up\u2026 (\" + i + \"/12)\";\n      await new Promise(r => setTimeout(r, 5000));\n      const d = await getVehicleData();\n      if (DATA_SOURCE === \"live\"){ location.reload(); return; }\n    }\n    st.textContent = \"Still asleep. Give it a minute and tap again.\";\n    btn.style.opacity = \"1\"; btn.style.pointerEvents = \"auto\";\n  });\n}\n\n(async function(){\n  const data = await getVehicleData();\n  if (DATA_SOURCE === \"demo\") {\n    showLanding();\n  } else if (DATA_SOURCE === \"wrongaccount\") {\n    showWrongAccount();\n  } else if (DATA_SOURCE === \"asleep\") {\n    showAsleep();\n  } else {\n    render(data);\n    wireControls(data);\n  }\n  const b = document.getElementById(\"boot\");\n  if (b) b.remove();\n})();\n</script>\n</body>\n</html>\n";
