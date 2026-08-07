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
      wheel_type: (v.vehicle_config || {}).wheel_type || null
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
  // static: only index.html exists
  const file = path.join(__dirname, "index.html");
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(500); return res.end("error"); }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(buf);
  });
});

server.listen(PORT, () => console.log(`Tesla Monitor on :${PORT}`));
