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
const SCOPES = "openid offline_access vehicle_device_data vehicle_location";

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
    if (!r.ok) throw new Error(`Fleet API ${r.status}`);
    const j = await r.json();
    if (g.sess.displayName && (!j.response.display_name || j.response.display_name === "My Tesla"))
      j.response.display_name = g.sess.displayName;
    res.writeHead(200, headers);
    res.end(JSON.stringify(mapFleetToApp(j.response)));
  } catch (e) {
    console.error("Fleet API error:", e.message);
    res.writeHead(200, headers);
    res.end(JSON.stringify({ demo: true, error: e.message }));
  }
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

function handleLogout(res) {
  res.writeHead(302, { "Set-Cookie": COOKIE_CLEAR, Location: "/" });
  res.end();
}

const server = http.createServer((req, res) => {
  const p = req.url.split("?")[0];
  if (p === "/api/vehicle") return handleVehicle(req, res);
  if (p === "/api/chargers") return handleChargers(req, res);
  if (p === "/healthz") { res.writeHead(200); return res.end("ok"); }
  if (p === "/.well-known/appspecific/com.tesla.3p.public-key.pem") return servePublicKey(res);
  if (p === "/setup/register") return handleRegister(res);
  if (p === "/auth/login") return handleLogin(res);
  if (p === "/auth/callback") return handleCallback(req, res);
  if (p === "/auth/logout") return handleLogout(res);
  // the whole dashboard is embedded below - server.js is the ONLY app file
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(INDEX_HTML);
});

server.listen(PORT, () => console.log(`Tesla Monitor on :${PORT}`));


/* ============ EMBEDDED DASHBOARD (v8) ============ */
const INDEX_HTML = "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"UTF-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0, viewport-fit=cover\">\n<title>Model Y</title>\n<link rel=\"stylesheet\" href=\"https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css\">\n<script src=\"https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js\"></script>\n<style>\n  :root{\n    --bg:#171a20;            /* Tesla brand dark */\n    --card:#1c2027;\n    --card-border:#262b33;\n    --elev:#2b3038;\n    --ink:#f4f4f4;\n    --ink-2:#9b9fa5;\n    --ink-3:#6b7076;\n    --accent:#3e6ae1;        /* Tesla blue */\n    --green:#3dbe5b;         /* charge green */\n    --green-track:#1e3a28;\n    --red:#e82127;\n    --hairline:#262b33;\n    --radius:16px;\n  }\n  *{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}\n  html,body{background:var(--bg)}\n  body{\n    font-family:\"Gotham SSm\",\"Gotham\",-apple-system,BlinkMacSystemFont,\"Inter\",\"Segoe UI\",Roboto,\"Helvetica Neue\",Arial,sans-serif;\n    color:var(--ink);\n    -webkit-font-smoothing:antialiased;\n    min-height:100vh;\n    display:flex;justify-content:center;\n  }\n  .app{width:100%;max-width:430px;padding:20px 20px 40px;position:relative}\n\n  /* ---------- header ---------- */\n  header{display:flex;align-items:flex-start;justify-content:space-between;padding-top:8px}\n  .car-title h1{font-size:22px;font-weight:600;letter-spacing:.2px}\n  .car-title .sub{font-size:13px;color:var(--ink-2);margin-top:3px;display:flex;align-items:center;gap:6px}\n  .dot{width:6px;height:6px;border-radius:50%;background:var(--green);display:inline-block}\n  .icon-btn{width:36px;height:36px;border-radius:50%;background:var(--card);border:1px solid var(--card-border);\n    display:flex;align-items:center;justify-content:center;color:var(--ink-2);cursor:pointer}\n  .icon-btn:active{background:var(--elev)}\n\n  /* ---------- battery line ---------- */\n  .battery-row{display:flex;align-items:center;gap:10px;margin-top:18px}\n  .batt{position:relative;width:30px;height:14px;border:1.5px solid var(--ink-2);border-radius:3.5px}\n  .batt::after{content:\"\";position:absolute;right:-4.5px;top:3.5px;width:3px;height:5px;background:var(--ink-2);border-radius:0 1.5px 1.5px 0}\n  .batt-fill{position:absolute;left:1.5px;top:1.5px;bottom:1.5px;border-radius:1.5px;background:var(--green);width:74%}\n  .batt-label{font-size:15px;font-weight:600}\n  .batt-label small{color:var(--ink-2);font-weight:400;font-size:14px;margin-left:6px}\n  .charging-bolt{color:var(--green);display:none}\n  .is-charging .charging-bolt{display:inline-flex;animation:pulse 1.6s ease-in-out infinite}\n  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}\n\n  /* ---------- sign in ---------- */\n  .signin-btn{display:block;margin:14px 0 0;background:var(--accent);color:#fff;text-align:center;\n    padding:13px;border-radius:12px;font-size:15px;font-weight:600;text-decoration:none}\n  .signin-btn:active{opacity:.85}\n  .signout{color:var(--ink-3);text-decoration:underline}\n\n  /* ---------- car ---------- */\n  .car-stage{margin:2px -8px 0;position:relative}\n  .car-stage::before{content:\"\";position:absolute;inset:-6% 4% 6% 4%;border-radius:50%;\n    background:radial-gradient(closest-side, rgba(62,106,225,.16), rgba(62,106,225,0) 72%);pointer-events:none}\n  .car-stage svg{width:100%;height:auto;display:block}\n  .car-shadow{filter:blur(14px);opacity:.5}\n\n  /* ---------- quick controls ---------- */\n  .controls{display:flex;justify-content:space-between;margin:14px 4px 6px}\n  .ctrl{display:flex;flex-direction:column;align-items:center;gap:7px;background:none;border:none;cursor:pointer;color:var(--ink);font-family:inherit}\n  .ctrl .circle{width:52px;height:52px;border-radius:50%;background:var(--card);border:1px solid var(--card-border);\n    display:flex;align-items:center;justify-content:center;color:var(--ink);transition:background .15s,color .15s,border-color .15s}\n  .ctrl span{font-size:11px;color:var(--ink-2)}\n  .ctrl.active .circle{background:var(--accent);border-color:var(--accent);color:#fff}\n  .ctrl:active .circle{background:var(--elev)}\n\n  /* ---------- stat tiles ---------- */\n  .tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:16px}\n  .tile{background:var(--card);border:1px solid var(--card-border);border-radius:14px;padding:12px 13px}\n  .tile .tl{font-size:11px;color:var(--ink-2);letter-spacing:.2px}\n  .tile .tv{font-size:19px;font-weight:600;margin-top:5px}\n  .tile .tv small{font-size:11px;font-weight:400;color:var(--ink-2);margin-left:3px}\n  .tile .td{font-size:10.5px;margin-top:4px;color:var(--ink-2)}\n  .tile .td.good{color:var(--green)}\n\n  .badge{font-size:9.5px;font-weight:700;letter-spacing:.8px;padding:2.5px 7px;border-radius:99px;\n    background:#3a3320;color:#e0b64a;border:1px solid #57492a;vertical-align:1px}\n  .badge.live{background:#1c3524;color:#4fd47a;border-color:#2a5238}\n\n  .meter-fill{overflow:hidden;position:absolute}\n  .is-charging .meter-fill::after{content:\"\";position:absolute;inset:0;\n    background:linear-gradient(100deg,transparent 30%,rgba(255,255,255,.35) 50%,transparent 70%);\n    animation:shimmer 2.2s linear infinite}\n  @keyframes shimmer{from{transform:translateX(-100%)}to{transform:translateX(100%)}}\n\n  .card,.tiles,.controls,.car-stage{animation:rise .45s ease both}\n  .card:nth-of-type(2){animation-delay:.05s}.card:nth-of-type(3){animation-delay:.1s}\n  @keyframes rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}\n  @media (prefers-reduced-motion: reduce){.card,.tiles,.controls,.car-stage{animation:none}.is-charging .meter-fill::after{animation:none}}\n\n  /* ---------- cards ---------- */\n  .card{background:var(--card);border:1px solid var(--card-border);border-radius:var(--radius);padding:18px;margin-top:14px}\n  .card-head{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:4px}\n  .card-head h2{font-size:16px;font-weight:600}\n  .card-head .meta{font-size:12.5px;color:var(--ink-2)}\n\n  /* charging card */\n  .charge-big{display:flex;align-items:baseline;gap:8px;margin-top:10px}\n  .charge-big .pct{font-size:44px;font-weight:600;letter-spacing:-.5px}\n  .charge-big .range{font-size:15px;color:var(--ink-2)}\n  .meter{position:relative;height:8px;border-radius:4px;background:var(--green-track);margin:14px 0 6px;overflow:hidden}\n  .meter-fill{position:absolute;left:0;top:0;bottom:0;background:var(--green);border-radius:4px 0 0 4px;width:74%}\n  .meter-limit{position:absolute;top:-3px;bottom:-3px;width:2px;background:var(--ink-3);left:90%}\n  .meter-scale{display:flex;justify-content:space-between;font-size:11px;color:var(--ink-3);margin-bottom:10px}\n  .charge-stats{display:flex;border-top:1px solid var(--hairline);margin-top:12px;padding-top:12px}\n  .cs{flex:1}\n  .cs + .cs{border-left:1px solid var(--hairline);padding-left:14px}\n  .cs .v{font-size:16px;font-weight:600}\n  .cs .k{font-size:11.5px;color:var(--ink-2);margin-top:3px}\n\n  /* charts */\n  .chart-wrap{position:relative;margin-top:14px}\n  .chart-wrap svg{display:block;width:100%;height:auto}\n  .chart-title{font-size:12.5px;color:var(--ink-2);margin-top:16px}\n  .tooltip{\n    position:absolute;pointer-events:none;background:#0f1216;border:1px solid #333941;border-radius:10px;\n    padding:8px 11px;font-size:12px;line-height:1.5;color:var(--ink-2);white-space:nowrap;z-index:10;\n    opacity:0;transition:opacity .1s;box-shadow:0 6px 20px rgba(0,0,0,.45)\n  }\n  .tooltip .tv{color:var(--ink);font-weight:600;font-size:13px}\n  .axis-text{font-size:10px;fill:var(--ink-3)}\n  .grid-line{stroke:#22262d;stroke-width:1}\n\n  /* climate */\n  .climate-body{display:flex;align-items:center;justify-content:space-between;margin-top:8px}\n  .temp-main{font-size:40px;font-weight:600}\n  .temp-main small{font-size:16px;color:var(--ink-2);font-weight:400}\n  .temp-sub{font-size:13px;color:var(--ink-2);margin-top:2px}\n  .temp-ctrl{display:flex;align-items:center;gap:14px}\n  .temp-btn{width:40px;height:40px;border-radius:50%;background:var(--elev);border:none;color:var(--ink);\n    font-size:20px;cursor:pointer;font-family:inherit}\n  .temp-set{font-size:17px;font-weight:600;min-width:44px;text-align:center}\n\n  /* location */\n  #liveMap{height:180px;border-radius:12px;border:1px solid var(--card-border);z-index:0}\n  .leaflet-container{background:#20242b;font:inherit}\n  .sc-row{display:flex;justify-content:space-between;align-items:center;padding:11px 0;border-bottom:1px solid var(--hairline);font-size:13.5px}\n  .sc-row:last-child{border-bottom:none;padding-bottom:0}\n  .sc-name{max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n  .sc-stat{font-weight:600}\n  .sc-stat small{color:var(--ink-2);font-weight:400;margin-left:6px}\n  .sc-good{color:var(--green)}.sc-mid{color:#e0b64a}.sc-low{color:var(--red)}\n  .map{border-radius:12px;overflow:hidden;margin-top:12px;position:relative;border:1px solid var(--card-border)}\n  .map svg{display:block;width:100%;height:auto}\n  .loc-line{display:flex;align-items:center;gap:8px;margin-top:12px;font-size:13.5px;color:var(--ink-2)}\n  .loc-line svg{flex:none}\n\n  /* info rows */\n  .rows{margin-top:6px}\n  .row{display:flex;justify-content:space-between;align-items:center;padding:12px 0;border-bottom:1px solid var(--hairline);font-size:14px}\n  .row:last-child{border-bottom:none;padding-bottom:0}\n  .row .k{color:var(--ink-2)}\n  .row .v{font-weight:500}\n\n  /* footer */\n  .demo-note{margin-top:22px;text-align:center;font-size:12px;color:var(--ink-3);line-height:1.6}\n  .demo-note b{color:var(--ink-2);font-weight:600}\n</style>\n</head>\n<body>\n<div class=\"app\" id=\"app\">\n\n  <header>\n    <div class=\"car-title\">\n      <h1 id=\"carName\">Steve's Model Y</h1>\n      <div class=\"sub\"><span class=\"dot\" id=\"statusDot\"></span><span id=\"statusText\">Charging \u00b7 Home</span>&nbsp;<span class=\"badge\" id=\"srcBadge\">DEMO</span></div>\n    </div>\n    <div class=\"icon-btn\" title=\"Account\">\n      <svg width=\"17\" height=\"17\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\"><circle cx=\"12\" cy=\"8\" r=\"4\"/><path d=\"M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5\"/></svg>\n    </div>\n  </header>\n\n  <div class=\"battery-row is-charging\" id=\"batteryRow\">\n    <div class=\"batt\"><div class=\"batt-fill\" id=\"battFill\"></div></div>\n    <div class=\"batt-label\"><span id=\"battPct\">74%</span><small id=\"battRange\">243 mi</small></div>\n    <span class=\"charging-bolt\">\n      <svg width=\"13\" height=\"13\" viewBox=\"0 0 24 24\" fill=\"currentColor\"><path d=\"M13 2 4 14h6l-1 8 9-12h-6l1-8z\"/></svg>\n    </span>\n  </div>\n\n  <a class=\"signin-btn\" id=\"signinBtn\" href=\"/auth/login\" style=\"display:none\">Sign in with Tesla</a>\n\n  <div class=\"car-stage\" id=\"carStage\"><!-- car SVG injected by JS --></div>\n\n  <div class=\"controls\">\n    <button class=\"ctrl active\" id=\"ctrlLock\" data-label-on=\"Locked\" data-label-off=\"Unlocked\">\n      <div class=\"circle\">\n        <svg width=\"21\" height=\"21\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"4.5\" y=\"10.5\" width=\"15\" height=\"10\" rx=\"2.5\"/><path class=\"lock-shackle\" d=\"M8 10.5V7a4 4 0 0 1 8 0v3.5\"/></svg>\n      </div><span>Locked</span>\n    </button>\n    <button class=\"ctrl\" id=\"ctrlClimate\">\n      <div class=\"circle\">\n        <svg width=\"21\" height=\"21\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\"><path d=\"M12 3v18M5.5 6.5 12 10l6.5-3.5M5.5 17.5 12 14l6.5 3.5\"/></svg>\n      </div><span>Climate</span>\n    </button>\n    <button class=\"ctrl active\" id=\"ctrlPort\">\n      <div class=\"circle\">\n        <svg width=\"21\" height=\"21\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M13 2 5 13h6l-1 9 8-11h-6l1-9z\"/></svg>\n      </div><span>Charge Port</span>\n    </button>\n    <button class=\"ctrl\" id=\"ctrlFrunk\">\n      <div class=\"circle\">\n        <svg width=\"21\" height=\"21\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M3 15h18M3 15c0-3 4-8 9-8s9 5 9 8M12 7V5\"/></svg>\n      </div><span>Frunk</span>\n    </button>\n    <button class=\"ctrl\" id=\"ctrlTrunk\">\n      <div class=\"circle\">\n        <svg width=\"21\" height=\"21\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M21 15H3M21 15c0-3-4-8-9-8M12 7c-2 0-4 .8-5.5 2M12 7V5\"/></svg>\n      </div><span>Trunk</span>\n    </button>\n  </div>\n\n  <div class=\"tiles\">\n    <div class=\"tile\"><div class=\"tl\">Efficiency \u00b7 7d</div><div class=\"tv\" id=\"tileEff\">263<small>Wh/mi</small></div><div class=\"td good\" id=\"tileEffD\">\u25bc 4% vs prior week</div></div>\n    <div class=\"tile\"><div class=\"tl\">Driven \u00b7 7d</div><div class=\"tv\" id=\"tileMi\">186<small>mi</small></div><div class=\"td\" id=\"tileMiD\">\u25b2 12% vs prior week</div></div>\n    <div class=\"tile\"><div class=\"tl\">Charge cost \u00b7 Aug</div><div class=\"tv\" id=\"tileCost\">$11.40</div><div class=\"td\" id=\"tileCostD\">92% at home</div></div>\n  </div>\n\n  <!-- Charging -->\n  <section class=\"card\" id=\"chargingCard\">\n    <div class=\"card-head\"><h2>Charging</h2><div class=\"meta\" id=\"chargeMeta\">32 min until limit</div></div>\n    <div class=\"charge-big\"><div class=\"pct\" id=\"chargePct\">74%</div><div class=\"range\" id=\"chargeRange\">243 mi</div></div>\n    <div class=\"meter is-charging\" id=\"meterWrap\"><div class=\"meter-fill\" id=\"meterFill\"></div><div class=\"meter-limit\" id=\"meterLimit\"></div></div>\n    <div class=\"meter-scale\"><span>0%</span><span id=\"limitLabel\">Limit 90%</span><span>100%</span></div>\n    <div class=\"charge-stats\">\n      <div class=\"cs\"><div class=\"v\" id=\"csPower\">7.4 kW</div><div class=\"k\">Charge rate</div></div>\n      <div class=\"cs\"><div class=\"v\" id=\"csAmps\">32 A \u00b7 240 V</div><div class=\"k\">Current session</div></div>\n      <div class=\"cs\"><div class=\"v\" id=\"csAdded\">+18.2 kWh</div><div class=\"k\">Energy added</div></div>\n    </div>\n    <div class=\"chart-title\">Tonight's charge session</div>\n    <div class=\"chart-wrap\" id=\"chargeChartWrap\">\n      <svg id=\"chargeChart\" viewBox=\"0 0 360 130\" role=\"img\" aria-label=\"Charge level over tonight's session, 42 to 74 percent\"></svg>\n      <div class=\"tooltip\" id=\"chargeTip\"></div>\n    </div>\n  </section>\n\n  <!-- Climate -->\n  <section class=\"card\">\n    <div class=\"card-head\"><h2>Climate</h2><div class=\"meta\" id=\"climateMeta\">Off</div></div>\n    <div class=\"climate-body\">\n      <div>\n        <div class=\"temp-main\" id=\"tempIn\">71<small>\u00b0F inside</small></div>\n        <div class=\"temp-sub\" id=\"tempOut\">64\u00b0F outside</div>\n      </div>\n      <div class=\"temp-ctrl\">\n        <button class=\"temp-btn\" id=\"tempDown\">\u2212</button>\n        <div class=\"temp-set\" id=\"tempSet\">70\u00b0</div>\n        <button class=\"temp-btn\" id=\"tempUp\">+</button>\n      </div>\n    </div>\n  </section>\n\n  <!-- Location -->\n  <section class=\"card\">\n    <div class=\"card-head\"><h2>Location</h2><div class=\"meta\">Parked \u00b7 Home</div></div>\n    <div class=\"map\" id=\"mapWrap\"><div id=\"liveMap\"></div></div>\n    <div class=\"loc-line\">\n      <svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\"><path d=\"M12 21s-7-5.5-7-11a7 7 0 0 1 14 0c0 5.5-7 11-7 11z\"/><circle cx=\"12\" cy=\"10\" r=\"2.5\"/></svg>\n      <span id=\"address\">2882 Sand Hill Rd, Menlo Park, CA</span>\n    </div>\n  </section>\n\n  <!-- Superchargers -->\n  <section class=\"card\">\n    <div class=\"card-head\"><h2>Superchargers</h2><div class=\"meta\" id=\"scMeta\">Nearby</div></div>\n    <div class=\"rows\" id=\"scRows\"></div>\n  </section>\n\n  <!-- Last 7 days -->\n  <section class=\"card\">\n    <div class=\"card-head\"><h2>Last 7 days</h2><div class=\"meta\" id=\"weekMeta\">186 mi driven</div></div>\n    <div class=\"chart-wrap\" id=\"weekChartWrap\">\n      <svg id=\"weekChart\" viewBox=\"0 0 360 140\" role=\"img\" aria-label=\"Miles driven per day over the last seven days\"></svg>\n      <div class=\"tooltip\" id=\"weekTip\"></div>\n    </div>\n  </section>\n\n  <!-- Specs -->\n  <section class=\"card\">\n    <div class=\"card-head\"><h2>Specs</h2><div class=\"meta\">From Tesla</div></div>\n    <div class=\"rows\">\n      <div class=\"row\"><span class=\"k\">Model</span><span class=\"v\" id=\"specModel\">Model Y</span></div>\n      <div class=\"row\"><span class=\"k\">Trim</span><span class=\"v\" id=\"specTrim\">\u2014</span></div>\n      <div class=\"row\"><span class=\"k\">Paint</span><span class=\"v\" id=\"specPaint\">\u2014</span></div>\n      <div class=\"row\"><span class=\"k\">Wheels</span><span class=\"v\" id=\"specWheels\">\u2014</span></div>\n      <div class=\"row\"><span class=\"k\">Roof \u00b7 Trim</span><span class=\"v\" id=\"specExtra\">\u2014</span></div>\n    </div>\n  </section>\n\n  <!-- Vehicle -->\n  <section class=\"card\">\n    <div class=\"card-head\"><h2>Vehicle</h2></div>\n    <div class=\"rows\">\n      <div class=\"row\"><span class=\"k\">Odometer</span><span class=\"v\" id=\"rowOdo\">18,443 mi</span></div>\n      <div class=\"row\"><span class=\"k\">Software</span><span class=\"v\" id=\"rowSoftware\">2026.20.4</span></div>\n      <div class=\"row\"><span class=\"k\">Sentry Mode</span><span class=\"v\" id=\"rowSentry\">Off</span></div>\n      <div class=\"row\"><span class=\"k\">Doors \u00b7 Windows</span><span class=\"v\" id=\"rowDoors\">Closed</span></div>\n      <div class=\"row\"><span class=\"k\">Efficiency (7 days)</span><span class=\"v\">263 Wh/mi</span></div>\n      <div class=\"row\"><span class=\"k\">Tire pressure</span><span class=\"v\" id=\"rowTires\">42 \u00b7 42 \u00b7 41 \u00b7 42 psi</span></div>\n      <div class=\"row\"><span class=\"k\">Interior \u00b7 Cabin overheat</span><span class=\"v\">On</span></div>\n    </div>\n  </section>\n\n  <div class=\"demo-note\" id=\"demoNote\">\n    <b id=\"footNote\">Demo data.</b><br>\n    <span id=\"footHint\">Tap \"Sign in with Tesla\" above to see your own car.</span>\n    <span style=\"opacity:.35\">v8</span> <a class=\"signout\" id=\"signoutLink\" href=\"/auth/logout\" style=\"display:none\"\n      onclick=\"try{localStorage.removeItem('bem_rt')}catch(e){}\">Sign out</a>\n  </div>\n\n</div>\n<script>\n\"use strict\";\n\n/* =====================================================================\n   DATA LAYER \u2014 swap this for your Tesla Fleet API proxy to go live.\n   The shape mirrors Fleet API's /api/1/vehicles/{id}/vehicle_data.\n   ===================================================================== */\nconst DEMO_DATA = {\n  display_name: \"Steve's Model Y\",\n  state: \"online\",\n  charge_state: {\n    charging_state: \"Charging\",          // \"Charging\" | \"Stopped\" | \"Disconnected\"\n    battery_level: 74,                    // %\n    battery_range: 243,                   // mi\n    charge_limit_soc: 90,                 // %\n    charger_power: 7.4,                   // kW\n    charger_actual_current: 32,           // A\n    charger_voltage: 240,                 // V\n    charge_energy_added: 18.2,            // kWh\n    minutes_to_full_charge: 32,\n    session: [                            // [minutes since 20:30, battery %]\n      [0,42],[15,45],[30,48],[45,51],[60,54],[75,57],[90,60],\n      [105,62],[120,65],[135,67],[150,69],[165,71],[180,73],[195,74]\n    ]\n  },\n  climate_state: {\n    inside_temp_f: 71, outside_temp_f: 64,\n    driver_temp_setting_f: 70, is_climate_on: false\n  },\n  drive_state: { shift_state: null, latitude: 37.4419, longitude: -122.1806, speed: null,\n    address: \"2882 Sand Hill Rd, Menlo Park, CA\" },\n  vehicle_config: { car_type: \"modely\", exterior_color: \"PearlWhite\", wheel_type: \"Gemini19\",\n    trim_badging: \"74d\", roof_color: \"RoofColorGlass\", spoiler_type: \"None\", exterior_trim: \"Black\" },\n  vehicle_state: {\n    odometer: 18443, car_version: \"2026.20.4\", locked: true,\n    tpms: [42,42,41,42], sentry_mode: false, doors_open: false, windows_open: false,\n    update_status: \"\", update_version: \"\"\n  },\n  week: [                                 // last 7 days of driving\n    {day:\"Fri\", mi:12},{day:\"Sat\", mi:41},{day:\"Sun\", mi:8},{day:\"Mon\", mi:26},\n    {day:\"Tue\", mi:31},{day:\"Wed\", mi:19},{day:\"Thu\", mi:49}\n  ]\n};\n\nlet DATA_SOURCE = \"demo\";\nfunction authHeaders(){\n  try{ const t = localStorage.getItem(\"bem_rt\"); return t ? { \"x-bem-rt\": t } : {}; }catch(e){ return {}; }\n}\nfunction noteRotation(r){\n  try{ const n = r.headers.get(\"x-bem-rt-new\"); if (n) localStorage.setItem(\"bem_rt\", n); }catch(e){}\n}\nasync function getVehicleData(){\n  /* The bundled server (server.js) exposes /api/vehicle. Until you add your\n     Tesla Fleet API credentials as environment variables on the server, it\n     answers {demo:true} and this dashboard runs on the demo dataset. */\n  try{\n    const r = await fetch(\"/api/vehicle\", {cache:\"no-store\", headers: authHeaders()});\n    if (r.ok){\n      noteRotation(r);\n      const j = await r.json();\n      if (!j.demo){ DATA_SOURCE = \"live\"; return j; }\n    }\n  }catch(e){ /* file:// or offline -> demo */ }\n  DATA_SOURCE = \"demo\";\n  return DEMO_DATA;\n}\n\n/* ============================ CAR RENDER ============================ */\n/* Tesla's own configurator render \u2014 the same imagery the Tesla app uses.\n   Color + wheels come from your vehicle_config, so it looks like YOUR car.\n   Falls back to the built-in SVG if the image can't load. */\nconst MODEL_SLUG = { modely:\"my\", model3:\"m3\", models:\"ms\", modelx:\"mx\" };\nconst COLOR_CODES = {\n  PearlWhite:\"$PPSW\", White:\"$PPSW\", SolidBlack:\"$PBSB\", Black:\"$PBSB\",\n  MidnightSilver:\"$PMNG\", Silver:\"$PMNG\", SteelGrey:\"$PMNG\",\n  DeepBlue:\"$PPSB\", DeepBlueMetallic:\"$PPSB\", Blue:\"$PPSB\",\n  RedMulticoat:\"$PPMR\", Red:\"$PPMR\", UltraRed:\"$PR01\",\n  Quicksilver:\"$PN01\", StealthGrey:\"$PN00\", Grey:\"$PN00\", Gray:\"$PN00\",\n  MidnightCherryRed:\"$PR00\", DiamondBlack:\"$PX02\", GlacierBlue:\"$PB01\"\n};\nconst WHEEL_CODES = {\n  Gemini19:\"$WY19B\", GeminiWheels19:\"$WY19B\", Photon19:\"$WY19C\",\n  Induction20:\"$WY20P\", InductionWheels20:\"$WY20P\", Crossflow20:\"$WY20A\",\n  Helix19:\"$WY19D\", Apollo19:\"$WY19B\"\n};\n// New-generation (2025+) Model Y colors/wheels -> try modern render codes first\nconst NEWGEN_COLORS = { StealthGrey:1, Quicksilver:1, UltraRed:1, GlacierBlue:1 };\nconst NEWGEN_WHEEL_CANDS = {\n  HelixV220: [\"$WY20J\",\"$WY20H\",\"$WY20X\",\"$WY20B\",\"$WY20P\"],\n  Crossflow19: [\"$WY19P\",\"$WY19J\"],\n  Helix220: [\"$WY20J\",\"$WY20H\"]\n};\nfunction carImageCandidates(cfg){\n  cfg = cfg || {};\n  const model = MODEL_SLUG[cfg.car_type] || \"my\";\n  const color = COLOR_CODES[cfg.exterior_color] || \"$PPSW\";\n  const legacyWheel = WHEEL_CODES[cfg.wheel_type] || \"$WY19B\";\n  const urls = [];\n  const mk = (opts, view, ctx) => \"https://static-assets.tesla.com/configurator/compositor?model=\" + model +\n    \"&options=\" + encodeURIComponent(opts) + \"&view=\" + view + \"&size=1400&bkba_opt=2\" +\n    (ctx ? \"&context=design_studio_2\" : \"\");\n  const isNewGen = NEWGEN_COLORS[cfg.exterior_color] || NEWGEN_WHEEL_CANDS[cfg.wheel_type];\n  if (model === \"my\" && isNewGen){\n    const wheels = NEWGEN_WHEEL_CANDS[cfg.wheel_type] || [\"$WY19P\"];\n    const trims = [\"$MTY47\",\"$MTY42\",\"$MTY43\"];\n    // pattern from Tesla's own new-MY configurator: $MDLY + trim + color + wheel\n    trims.forEach(t => wheels.slice(0,2).forEach(w => {\n      urls.push(mk(\"$MDLY,\" + t + \",\" + color + \",\" + w, \"SIDE\", true));\n    }));\n    urls.push(mk(\"$MDLY,$MTY47,\" + color, \"SIDE\", true));\n    urls.push(mk(\"$MDLY,\" + color, \"SIDE\", true));\n    urls.push(mk(\"$MDLY,$MTY47,\" + color + \",\" + wheels[0], \"STUD_SIDE\", true));\n    urls.push(mk(\"$MDLY,$MTY47,\" + color + \",\" + wheels[0], \"FRONT34\", true));\n    wheels.forEach(w => urls.push(mk(\"$MTY13,\" + color + \",\" + w, \"STUD_SIDE\", true)));\n  }\n  urls.push(mk(color + \",\" + legacyWheel, \"STUD_SIDE\", false));\n  urls.push(mk(color, \"STUD_SIDE\", false));\n  return urls;\n}\nfunction mountCarImage(cfg){\n  const stage = document.getElementById(\"carStage\");\n  stage.innerHTML = carSVG();               // instant fallback\n  const urls = carImageCandidates(cfg);\n  let i = 0;\n  function tryNext(){\n    if (i >= urls.length) return;           // all failed -> SVG stays\n    const img = new Image();\n    img.alt = \"Your car\";\n    img.style.cssText = \"width:100%;display:block;filter:drop-shadow(0 20px 18px rgba(0,0,0,.45))\";\n    img.onload = () => {\n      // compositor sometimes 200s a tiny blank for bad codes - require real size\n      if (img.naturalWidth > 300){ stage.innerHTML = \"\"; stage.appendChild(img); }\n      else { i++; tryNext(); }\n    };\n    img.onerror = () => { i++; tryNext(); };\n    img.src = urls[i];\n  }\n  tryNext();\n}\n\nfunction carSVG(){\n  return `\n  <svg viewBox=\"0 0 760 300\" aria-label=\"Model Y side profile\">\n  <defs>\n    <linearGradient id=\"bodyG\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n      <stop offset=\"0\" stop-color=\"#767d86\"/>\n      <stop offset=\".4\" stop-color=\"#565d66\"/>\n      <stop offset=\".75\" stop-color=\"#3b4148\"/>\n      <stop offset=\"1\" stop-color=\"#2e3339\"/>\n    </linearGradient>\n    <linearGradient id=\"glassG\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n      <stop offset=\"0\" stop-color=\"#3d444e\"/>\n      <stop offset=\"1\" stop-color=\"#15181d\"/>\n    </linearGradient>\n    <radialGradient id=\"shadowG\" cx=\".5\" cy=\".5\" r=\".5\">\n      <stop offset=\"0\" stop-color=\"#000\" stop-opacity=\".6\"/>\n      <stop offset=\"1\" stop-color=\"#000\" stop-opacity=\"0\"/>\n    </radialGradient>\n  </defs>\n\n  <ellipse cx=\"378\" cy=\"252\" rx=\"300\" ry=\"15\" fill=\"url(#shadowG)\"/>\n\n  <!-- wheel wells (dark, behind body cutouts) -->\n  <circle cx=\"176\" cy=\"200\" r=\"52\" fill=\"#0b0d10\"/>\n  <circle cx=\"552\" cy=\"200\" r=\"52\" fill=\"#0b0d10\"/>\n\n  <!-- body -->\n  <path fill=\"url(#bodyG)\" d=\"\n    M 118,218\n    C 100,214 90,206 88,194\n    C 87,180 87,170 92,162\n    C 102,148 122,141 142,137\n    C 166,131 192,125 214,118\n    C 240,84 278,52 322,42\n    C 374,36 428,46 464,66\n    C 492,84 508,93 520,100\n    C 546,106 580,112 606,116\n    L 626,114\n    C 640,117 646,126 646,138\n    C 646,166 640,188 628,200\n    C 619,209 610,215 600,218\n    A 55,55 0 1 0 499,218\n    L 229,218\n    A 55,55 0 1 0 123,218\n    L 118,218 Z\"/>\n\n  <!-- black wheel-arch cladding (Model Y signature) -->\n  <path d=\"M 605,218 A 55,55 0 1 0 499,218\" fill=\"none\" stroke=\"#111317\" stroke-width=\"6\" stroke-linecap=\"round\"/>\n  <path d=\"M 229,218 A 55,55 0 1 0 123,218\" fill=\"none\" stroke=\"#111317\" stroke-width=\"6\" stroke-linecap=\"round\"/>\n\n  <!-- glass -->\n  <path fill=\"url(#glassG)\" d=\"\n    M 228,112\n    C 250,80 288,50 326,44\n    C 374,38 422,47 458,66\n    C 484,79 502,91 514,99\n    C 450,96 320,102 228,112 Z\"/>\n  <!-- B pillar -->\n  <path d=\"M 358,47 L 366,104\" stroke=\"#14171c\" stroke-width=\"6\" opacity=\".85\"/>\n\n  <!-- beltline chrome-delete trim -->\n  <path d=\"M 228,113 C 320,103 450,97 516,100\" stroke=\"#9fa6ae\" stroke-width=\"1.6\" fill=\"none\" opacity=\".8\"/>\n  <path d=\"M 214,118 C 240,84 278,52 322,42 C 374,36 428,46 464,66\" stroke=\"#aab1b9\" stroke-width=\"1.4\" fill=\"none\" opacity=\".35\"/>\n\n  <!-- door seams -->\n  <path d=\"M 364,113 C 362,146 362,184 364,214\" stroke=\"#232830\" stroke-width=\"1.6\" fill=\"none\" opacity=\".9\"/>\n  <path d=\"M 254,117 C 252,146 252,184 254,216\" stroke=\"#232830\" stroke-width=\"1.4\" fill=\"none\" opacity=\".7\"/>\n  <path d=\"M 488,92 C 490,124 490,174 488,214\" stroke=\"#232830\" stroke-width=\"1.4\" fill=\"none\" opacity=\".6\"/>\n\n  <!-- handles -->\n  <rect x=\"294\" y=\"128\" width=\"32\" height=\"4.5\" rx=\"2.2\" fill=\"#9aa0a8\"/>\n  <rect x=\"416\" y=\"128\" width=\"32\" height=\"4.5\" rx=\"2.2\" fill=\"#9aa0a8\"/>\n\n  <!-- mirror -->\n  <path d=\"M 250,110 C 240,100 228,98 222,102 C 220,109 228,114 242,115 Z\" fill=\"#6b727b\"/>\n\n  <!-- headlight -->\n  <path d=\"M 94,154 C 106,148 122,143 140,140 L 146,144 C 128,148 112,154 102,160 Z\" fill=\"#dfeaf6\"/>\n\n  <!-- taillight -->\n  <path d=\"M 626,115 C 637,117 644,124 646,134 L 634,129 C 631,122 629,118 626,115 Z\" fill=\"#d64541\"/>\n\n  <!-- wheels -->\n  <g id=\"wheel1\">\n    <circle cx=\"176\" cy=\"200\" r=\"48\" fill=\"#0d0f13\"/>\n    <circle cx=\"176\" cy=\"200\" r=\"29\" fill=\"#363b42\"/>\n    <circle cx=\"176\" cy=\"200\" r=\"29\" fill=\"none\" stroke=\"#484e56\" stroke-width=\"2\"/>\n    <g fill=\"#1a1d22\">\n      <path d=\"M 176,200 L 166,175 A 27,27 0 0 1 186,175 Z\"/>\n      <path d=\"M 176,200 L 201,192 A 27,27 0 0 1 195,216 Z\"/>\n      <path d=\"M 176,200 L 184,225 A 27,27 0 0 1 160,218 Z\"/>\n      <path d=\"M 176,200 L 151,208 A 27,27 0 0 1 153,184 Z\"/>\n    </g>\n    <circle cx=\"176\" cy=\"200\" r=\"7\" fill=\"#585e66\"/>\n    <circle cx=\"176\" cy=\"200\" r=\"3\" fill=\"#22252a\"/>\n  </g>\n  <use href=\"#wheel1\" x=\"376\"/>\n</svg>`;\n}\n\n/* ============================ MAP RENDER ============================ */\nfunction mapSVG(){\n  return `\n  <svg viewBox=\"0 0 390 150\" aria-label=\"Map showing the car parked at home\">\n    <rect width=\"390\" height=\"150\" fill=\"#20242b\"/>\n    <rect x=\"0\" y=\"0\" width=\"120\" height=\"64\" fill=\"#232d22\" opacity=\".8\"/>\n    <rect x=\"300\" y=\"96\" width=\"90\" height=\"54\" fill=\"#232d22\" opacity=\".6\"/>\n    <g stroke=\"#2e343d\" stroke-width=\"10\" stroke-linecap=\"round\">\n      <path d=\"M -10,104 C 90,96 210,110 400,88\" fill=\"none\"/>\n      <path d=\"M 132,-10 C 128,50 140,110 132,160\" fill=\"none\"/>\n    </g>\n    <g stroke=\"#3a414c\" stroke-width=\"4\" stroke-linecap=\"round\">\n      <path d=\"M -10,44 L 400,36\" fill=\"none\"/>\n      <path d=\"M 258,-10 L 266,160\" fill=\"none\"/>\n      <path d=\"M 40,150 L 60,70\" fill=\"none\"/>\n    </g>\n    <g stroke=\"#454d59\" stroke-width=\"1.4\" stroke-dasharray=\"7 7\" opacity=\".7\">\n      <path d=\"M -10,102 C 90,94 210,108 400,86\" fill=\"none\"/>\n    </g>\n    <circle cx=\"196\" cy=\"86\" r=\"16\" fill=\"#3e6ae1\" opacity=\".18\"/>\n    <circle cx=\"196\" cy=\"86\" r=\"7\" fill=\"#3e6ae1\" stroke=\"#fff\" stroke-width=\"2.5\"/>\n  </svg>`;\n}\n\n/* ========================== CHART HELPERS =========================== */\nconst NS = \"http://www.w3.org/2000/svg\";\nfunction el(name, attrs, parent){\n  const n = document.createElementNS(NS, name);\n  for (const k in attrs) n.setAttribute(k, attrs[k]);\n  if (parent) parent.appendChild(n);\n  return n;\n}\nfunction fmtTime(min){ // minutes since 20:30\n  const t = 20*60+30 + min, h = Math.floor(t/60)%24, m = t%60;\n  const hh = ((h+11)%12)+1, ap = h < 12 ? \"AM\" : \"PM\";\n  return hh + \":\" + String(m).padStart(2,\"0\") + \" \" + ap;\n}\n\n/* -------- charge session line chart (crosshair + tooltip) ---------- */\nfunction renderChargeChart(data){\n  if (!data.charge_state.session || data.charge_state.session.length < 3)\n    data = Object.assign({}, data, { charge_state: Object.assign({}, DEMO_DATA.charge_state,\n      { battery_level: data.charge_state.battery_level, charge_limit_soc: data.charge_state.charge_limit_soc }) });\n  const svg = document.getElementById(\"chargeChart\");\n  const wrap = document.getElementById(\"chargeChartWrap\");\n  const tip = document.getElementById(\"chargeTip\");\n  svg.textContent = \"\";\n\n  const W=360, H=130, L=30, R=14, T=12, B=24;\n  const pts = data.charge_state.session;\n  const limit = data.charge_state.charge_limit_soc;\n  const xMax = 240;                       // show through 00:30 for projection\n  const yMin = 30, yMax = 100;\n  const x = m => L + (m/xMax)*(W-L-R);\n  const y = p => T + (1-(p-yMin)/(yMax-yMin))*(H-T-B);\n\n  // grid + y ticks\n  [40,60,80,100].forEach(p=>{\n    el(\"line\",{x1:L,x2:W-R,y1:y(p),y2:y(p),class:\"grid-line\"},svg);\n    const t=el(\"text\",{x:L-6,y:y(p)+3,\"text-anchor\":\"end\",class:\"axis-text\"},svg);\n    t.textContent=p;\n  });\n  // x ticks: 21:00, 22:00, 23:00, 00:00\n  [30,90,150,210].forEach((m,i)=>{\n    const t=el(\"text\",{x:x(m),y:H-8,\"text-anchor\":\"middle\",class:\"axis-text\"},svg);\n    t.textContent=[\"9 PM\",\"10 PM\",\"11 PM\",\"12 AM\"][i];\n  });\n  // limit line\n  el(\"line\",{x1:L,x2:W-R,y1:y(limit),y2:y(limit),stroke:\"#6b7076\",\"stroke-width\":1,\"stroke-dasharray\":\"3 4\"},svg);\n  const lt=el(\"text\",{x:W-R,y:y(limit)-4,\"text-anchor\":\"end\",class:\"axis-text\"},svg);\n  lt.textContent=\"Limit \" + limit + \"%\";\n\n  // area + line (actual)\n  const last = pts[pts.length-1];\n  let dLine = \"\", dArea = \"M \" + x(pts[0][0]) + \" \" + y(yMin);\n  pts.forEach(([m,p],i)=>{\n    dLine += (i? \" L \":\"M \") + x(m).toFixed(1) + \" \" + y(p).toFixed(1);\n    dArea += \" L \" + x(m).toFixed(1) + \" \" + y(p).toFixed(1);\n  });\n  dArea += \" L \" + x(last[0]).toFixed(1) + \" \" + y(yMin) + \" Z\";\n  el(\"path\",{d:dArea,fill:\"#3dbe5b\",opacity:.1},svg);\n  el(\"path\",{d:dLine,fill:\"none\",stroke:\"#3dbe5b\",\"stroke-width\":2,\"stroke-linejoin\":\"round\",\"stroke-linecap\":\"round\"},svg);\n\n  // projection to limit (dashed)\n  const eta = last[0] + data.charge_state.minutes_to_full_charge;\n  el(\"path\",{d:\"M \"+x(last[0])+\" \"+y(last[1])+\" L \"+x(eta)+\" \"+y(limit),\n    fill:\"none\",stroke:\"#3dbe5b\",\"stroke-width\":2,\"stroke-dasharray\":\"2 5\",\n    \"stroke-linecap\":\"round\",opacity:.55},svg);\n\n  // end marker + label\n  el(\"circle\",{cx:x(last[0]),cy:y(last[1]),r:4.5,fill:\"#3dbe5b\",stroke:\"#1c2027\",\"stroke-width\":2},svg);\n  const endT=el(\"text\",{x:x(last[0]),y:y(last[1])-9,\"text-anchor\":\"middle\",\n    class:\"axis-text\",style:\"font-size:11px;font-weight:600;fill:#f4f4f4\"},svg);\n  endT.textContent = last[1] + \"%\";\n\n  // crosshair + tooltip\n  const cross = el(\"line\",{y1:T,y2:H-B,stroke:\"#454d59\",\"stroke-width\":1,opacity:0},svg);\n  const hoverDot = el(\"circle\",{r:4,fill:\"#3dbe5b\",stroke:\"#1c2027\",\"stroke-width\":2,opacity:0},svg);\n\n  function showTip(evt){\n    const rect = svg.getBoundingClientRect();\n    const mx = (evt.clientX-rect.left) * (W/rect.width);\n    const minAtX = Math.max(0, Math.min(last[0], (mx-L)/(W-L-R)*xMax));\n    let best = pts[0];\n    for (const p of pts) if (Math.abs(p[0]-minAtX) < Math.abs(best[0]-minAtX)) best = p;\n    cross.setAttribute(\"x1\",x(best[0])); cross.setAttribute(\"x2\",x(best[0]));\n    cross.setAttribute(\"opacity\",1);\n    hoverDot.setAttribute(\"cx\",x(best[0])); hoverDot.setAttribute(\"cy\",y(best[1]));\n    hoverDot.setAttribute(\"opacity\",1);\n    tip.textContent=\"\";\n    const v=document.createElement(\"div\"); v.className=\"tv\"; v.textContent=best[1]+\"%\";\n    const k=document.createElement(\"div\"); k.textContent=fmtTime(best[0]);\n    tip.append(v,k);\n    const wr = wrap.getBoundingClientRect();\n    const px = x(best[0])/W*wr.width;\n    tip.style.left = Math.min(wr.width-96, Math.max(4, px+10)) + \"px\";\n    tip.style.top = \"6px\";\n    tip.style.opacity = 1;\n  }\n  function hideTip(){ tip.style.opacity=0; cross.setAttribute(\"opacity\",0); hoverDot.setAttribute(\"opacity\",0); }\n  svg.addEventListener(\"pointermove\", showTip);\n  svg.addEventListener(\"pointerleave\", hideTip);\n}\n\n/* --------------- weekly bar chart (per-bar tooltip) ----------------- */\nfunction renderWeekChart(data){\n  if (!data.week || !data.week.length) data = Object.assign({}, data, { week: DEMO_DATA.week });\n  const svg = document.getElementById(\"weekChart\");\n  const wrap = document.getElementById(\"weekChartWrap\");\n  const tip = document.getElementById(\"weekTip\");\n  svg.textContent = \"\";\n\n  const W=360, H=140, L=26, R=8, T=16, B=26;\n  const days = data.week;\n  const maxV = 50; // clean top\n  const slot = (W-L-R)/days.length;\n  const bw = Math.min(24, slot-14);\n  const y = v => T + (1-v/maxV)*(H-T-B);\n\n  [0,25,50].forEach(v=>{\n    el(\"line\",{x1:L,x2:W-R,y1:y(v),y2:y(v),class:\"grid-line\"},svg);\n    const t=el(\"text\",{x:L-6,y:y(v)+3,\"text-anchor\":\"end\",class:\"axis-text\"},svg);\n    t.textContent=v;\n  });\n\n  const maxDay = days.reduce((a,b)=> b.mi>a.mi?b:a, days[0]);\n  days.forEach((d,i)=>{\n    const cx = L + slot*i + slot/2;\n    const bh = Math.max(0, y(0)-y(d.mi));\n    const r = Math.min(4, bh);\n    const bar = el(\"path\",{\n      d:`M ${cx-bw/2} ${y(0)} L ${cx-bw/2} ${y(d.mi)+r} Q ${cx-bw/2} ${y(d.mi)} ${cx-bw/2+r} ${y(d.mi)}\n         L ${cx+bw/2-r} ${y(d.mi)} Q ${cx+bw/2} ${y(d.mi)} ${cx+bw/2} ${y(d.mi)+r} L ${cx+bw/2} ${y(0)} Z`,\n      fill:\"#3e6ae1\"},svg);\n    const lab=el(\"text\",{x:cx,y:H-8,\"text-anchor\":\"middle\",class:\"axis-text\"},svg);\n    lab.textContent=d.day;\n    if (d===maxDay){\n      const v=el(\"text\",{x:cx,y:y(d.mi)-6,\"text-anchor\":\"middle\",class:\"axis-text\",\n        style:\"font-size:11px;font-weight:600;fill:#f4f4f4\"},svg);\n      v.textContent=d.mi+\" mi\";\n    }\n    // oversized hit target\n    const hit = el(\"rect\",{x:L+slot*i,y:T,width:slot,height:H-T-B,fill:\"transparent\"},svg);\n    function over(){\n      bar.setAttribute(\"fill\",\"#5b82e8\");\n      tip.textContent=\"\";\n      const tv=document.createElement(\"div\"); tv.className=\"tv\"; tv.textContent=d.mi+\" mi\";\n      const tk=document.createElement(\"div\"); tk.textContent=d.day;\n      tip.append(tv,tk);\n      const wr = wrap.getBoundingClientRect();\n      const px = cx/W*wr.width;\n      tip.style.left = Math.min(wr.width-80, Math.max(4, px-30)) + \"px\";\n      tip.style.top = \"0px\";\n      tip.style.opacity = 1;\n    }\n    function out(){ bar.setAttribute(\"fill\",\"#3e6ae1\"); tip.style.opacity=0; }\n    hit.addEventListener(\"pointerenter\", over);\n    hit.addEventListener(\"pointerleave\", out);\n  });\n}\n\n/* ==================== LIVE MAP & SUPERCHARGERS ====================== */\nlet liveMap = null, liveMarker = null;\nfunction renderMap(ds){\n  const el = document.getElementById(\"liveMap\");\n  const lat = ds.latitude, lon = ds.longitude;\n  if (!el || typeof L === \"undefined\" || lat == null || lon == null){\n    // fallback: stylized static map\n    document.getElementById(\"mapWrap\").innerHTML = mapSVG();\n    return;\n  }\n  el.style.display = \"block\";\n  if (!liveMap){\n    liveMap = L.map(\"liveMap\", { zoomControl:false, attributionControl:false, dragging:true, scrollWheelZoom:false });\n    L.tileLayer(\"https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png\", { maxZoom: 19 }).addTo(liveMap);\n  }\n  liveMap.setView([lat, lon], 15);\n  if (liveMarker) liveMarker.remove();\n  liveMarker = L.circleMarker([lat, lon], { radius:8, color:\"#fff\", weight:2.5, fillColor:\"#3e6ae1\", fillOpacity:1 }).addTo(liveMap);\n  // reverse geocode for a human address (best-effort)\n  fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}`)\n    .then(r => r.json())\n    .then(j => {\n      const a = j.address || {};\n      const line = [a.house_number, a.road].filter(Boolean).join(\" \");\n      const town = a.city || a.town || a.village || a.hamlet || \"\";\n      const txt = [line, town, a.state].filter(Boolean).join(\", \");\n      if (txt) document.getElementById(\"address\").textContent = txt;\n    }).catch(()=>{});\n}\n\nconst DEMO_CHARGERS = [\n  { name: \"Menlo Park, CA\", distance_miles: 1.2, available_stalls: 9, total_stalls: 12 },\n  { name: \"Palo Alto - Stanford\", distance_miles: 2.8, available_stalls: 4, total_stalls: 16 },\n  { name: \"Redwood City, CA\", distance_miles: 4.1, available_stalls: 11, total_stalls: 20 }\n];\nasync function renderChargers(){\n  let list = DEMO_CHARGERS;\n  try{\n    const r = await fetch(\"/api/chargers\", { cache: \"no-store\", headers: authHeaders() });\n    if (r.ok){ const j = await r.json(); if (j.superchargers && j.superchargers.length) list = j.superchargers; }\n  }catch(e){}\n  const wrap = document.getElementById(\"scRows\");\n  wrap.textContent = \"\";\n  list.slice(0, 5).forEach(c => {\n    const row = document.createElement(\"div\"); row.className = \"sc-row\";\n    const name = document.createElement(\"div\"); name.className = \"sc-name\"; name.textContent = c.name;\n    const stat = document.createElement(\"div\"); stat.className = \"sc-stat\";\n    if (c.available_stalls != null && c.total_stalls != null){\n      const frac = c.total_stalls ? c.available_stalls / c.total_stalls : 0;\n      const cls = frac > 0.4 ? \"sc-good\" : (frac > 0.15 ? \"sc-mid\" : \"sc-low\");\n      const strong = document.createElement(\"span\"); strong.className = cls;\n      strong.textContent = `${c.available_stalls}/${c.total_stalls}`;\n      stat.appendChild(strong);\n    }\n    const dist = document.createElement(\"small\"); dist.textContent = `${c.distance_miles} mi`;\n    stat.appendChild(dist);\n    row.append(name, stat); wrap.appendChild(row);\n  });\n}\n\n/* ============================ RENDER ================================ */\nfunction render(data){\n  const cs = data.charge_state, cl = data.climate_state, vs = data.vehicle_state;\n  const set = (id,txt)=>{ document.getElementById(id).textContent = txt; };\n\n  set(\"carName\", data.display_name);\n  const badge = document.getElementById(\"srcBadge\");\n  const live = DATA_SOURCE === \"live\";\n  badge.textContent = live ? \"LIVE\" : \"DEMO\";\n  badge.classList.toggle(\"live\", live);\n  document.getElementById(\"signinBtn\").style.display = live ? \"none\" : \"block\";\n  document.getElementById(\"footNote\").textContent = live ? \"Connected to your Tesla.\" : \"Demo data.\";\n  document.getElementById(\"footHint\").style.display = live ? \"none\" : \"inline\";\n  document.getElementById(\"signoutLink\").style.display = live ? \"inline\" : \"none\";\n  const charging = cs.charging_state === \"Charging\";\n  set(\"statusText\", charging ? \"Charging \u00b7 Home\" : \"Parked \u00b7 Home\");\n  document.getElementById(\"batteryRow\").classList.toggle(\"is-charging\", charging);\n\n  set(\"battPct\", cs.battery_level + \"%\");\n  set(\"battRange\", cs.battery_range + \" mi\");\n  document.getElementById(\"battFill\").style.width = cs.battery_level + \"%\";\n  document.getElementById(\"battFill\").style.background =\n    cs.battery_level <= 20 ? \"var(--red)\" : \"var(--green)\";\n\n  set(\"chargePct\", cs.battery_level + \"%\");\n  set(\"chargeRange\", cs.battery_range + \" mi\");\n  set(\"chargeMeta\", charging ? cs.minutes_to_full_charge + \" min until limit\" : \"Plugged in\");\n  document.getElementById(\"meterFill\").style.width = cs.battery_level + \"%\";\n  document.getElementById(\"meterLimit\").style.left = cs.charge_limit_soc + \"%\";\n  set(\"limitLabel\", \"Limit \" + cs.charge_limit_soc + \"%\");\n  set(\"csPower\", cs.charger_power.toFixed(1) + \" kW\");\n  set(\"csAmps\", cs.charger_actual_current + \" A \u00b7 \" + cs.charger_voltage + \" V\");\n  set(\"csAdded\", \"+\" + cs.charge_energy_added.toFixed(1) + \" kWh\");\n\n  document.getElementById(\"tempIn\").childNodes[0].textContent = cl.inside_temp_f;\n  set(\"tempOut\", cl.outside_temp_f + \"\u00b0F outside\");\n  set(\"tempSet\", cl.driver_temp_setting_f + \"\u00b0\");\n  set(\"climateMeta\", cl.is_climate_on ? \"Keeping \" + cl.driver_temp_setting_f + \"\u00b0\" : \"Off\");\n\n  if (data.drive_state.address) set(\"address\", data.drive_state.address);\n  else set(\"address\", \"Locating\u2026\");\n  renderMap(data.drive_state);\n  renderChargers();\n\n  set(\"rowOdo\", vs.odometer.toLocaleString() + \" mi\");\n  set(\"rowSoftware\", vs.update_status\n    ? (vs.car_version + \" \u2192 \" + (vs.update_version || \"update\") + \" \" + vs.update_status)\n    : vs.car_version + \" \u00b7 Up to date\");\n  set(\"rowSentry\", vs.sentry_mode ? \"On\" : \"Off\");\n  set(\"rowDoors\", (vs.doors_open || vs.windows_open)\n    ? [(vs.doors_open ? \"Door open\" : null), (vs.windows_open ? \"Window open\" : null)].filter(Boolean).join(\" \u00b7 \")\n    : \"Closed\");\n  if (vs.tpms && vs.tpms.some(p => p != null))\n    set(\"rowTires\", vs.tpms.map(p => p ?? \"\u2013\").join(\" \u00b7 \") + \" psi\");\n\n  const wk = data.week || [];\n  set(\"weekMeta\", wk.length ? wk.reduce((s,d)=>s+d.mi,0) + \" mi driven\" : \"Sample data\");\n\n  mountCarImage(data.vehicle_config);\n  const vc = data.vehicle_config || {};\n  const nice = x => x ? String(x).replace(/([a-z])([A-Z])/g, \"$1 $2\") : \"\u2014\";\n  set(\"specModel\", ({modely:\"Model Y\", model3:\"Model 3\", models:\"Model S\", modelx:\"Model X\"})[vc.car_type] || vc.car_type || \"\u2014\");\n  set(\"specTrim\", vc.trim_badging ? String(vc.trim_badging).toUpperCase() : \"\u2014\");\n  set(\"specPaint\", nice(vc.exterior_color));\n  set(\"specWheels\", nice(vc.wheel_type));\n  set(\"specExtra\", [nice(vc.roof_color), nice(vc.exterior_trim)].filter(x=>x!==\"\u2014\").join(\" \u00b7 \") || \"\u2014\");\n  renderChargeChart(data);\n  renderWeekChart(data);\n}\n\n/* ========================= INTERACTIONS ============================= */\nfunction wireControls(data){\n  const lock = document.getElementById(\"ctrlLock\");\n  lock.addEventListener(\"click\", ()=>{\n    const on = lock.classList.toggle(\"active\");\n    lock.querySelector(\"span\").textContent = on ? \"Locked\" : \"Unlocked\";\n  });\n  const climate = document.getElementById(\"ctrlClimate\");\n  climate.addEventListener(\"click\", ()=>{\n    const on = climate.classList.toggle(\"active\");\n    data.climate_state.is_climate_on = on;\n    document.getElementById(\"climateMeta\").textContent =\n      on ? \"Keeping \" + data.climate_state.driver_temp_setting_f + \"\u00b0\" : \"Off\";\n  });\n  [\"ctrlPort\",\"ctrlFrunk\",\"ctrlTrunk\"].forEach(id=>{\n    const b = document.getElementById(id);\n    b.addEventListener(\"click\", ()=> b.classList.toggle(\"active\"));\n  });\n  const setEl = document.getElementById(\"tempSet\");\n  document.getElementById(\"tempUp\").addEventListener(\"click\", ()=>{\n    data.climate_state.driver_temp_setting_f = Math.min(82, data.climate_state.driver_temp_setting_f+1);\n    setEl.textContent = data.climate_state.driver_temp_setting_f + \"\u00b0\";\n  });\n  document.getElementById(\"tempDown\").addEventListener(\"click\", ()=>{\n    data.climate_state.driver_temp_setting_f = Math.max(59, data.climate_state.driver_temp_setting_f-1);\n    setEl.textContent = data.climate_state.driver_temp_setting_f + \"\u00b0\";\n  });\n}\n\n/* ============================== BOOT ================================ */\n(async function(){\n  const data = await getVehicleData();\n  render(data);\n  wireControls(data);\n})();\n</script>\n</body>\n</html>\n";
