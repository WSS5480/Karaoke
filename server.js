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

/* ---- token management ----
   Access tokens live ~8h. We keep one in memory and refresh it using, in order:
   1) refresh token stored in env TESLA_REFRESH_TOKEN (survives restarts)
   2) refresh token captured in-memory from a fresh /auth/login flow
   3) a manually-set TESLA_TOKEN env (no refresh; legacy option)          */
let mem = { access_token: null, refresh_token: null, expires_at: 0 };

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

async function getAccessToken() {
  if (mem.access_token && Date.now() < mem.expires_at - 60000) return mem.access_token;
  const rt = mem.refresh_token || process.env.TESLA_REFRESH_TOKEN;
  if (rt && CLIENT_SECRET) {
    const j = await tokenPost({
      grant_type: "refresh_token", client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET, refresh_token: rt
    });
    mem.access_token = j.access_token;
    mem.refresh_token = j.refresh_token || rt;
    mem.expires_at = Date.now() + (j.expires_in || 28800) * 1000;
    return mem.access_token;
  }
  if (process.env.TESLA_TOKEN) return process.env.TESLA_TOKEN;
  return null;
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
      address: "See Tesla app for precise location"
    },
    vehicle_state: {
      odometer: Math.round(vs.odometer ?? 0),
      car_version: (vs.car_version || "").split(" ")[0],
      locked: !!vs.locked,
      tpms: [vs.tpms_pressure_fl, vs.tpms_pressure_fr, vs.tpms_pressure_rl, vs.tpms_pressure_rr]
        .map(p => (p ? Math.round(p * 14.5) : null)) // bar -> psi
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

let cachedVehicleId = null;

/** Auto-discover the account's vehicle (first one) unless TESLA_VEHICLE_ID is set. */
async function getVehicleId(token) {
  if (process.env.TESLA_VEHICLE_ID) return process.env.TESLA_VEHICLE_ID;
  if (cachedVehicleId) return cachedVehicleId;
  const r = await fetch(`${BASE}/api/1/vehicles`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!r.ok) throw new Error(`Fleet API vehicles ${r.status}`);
  const j = await r.json();
  const list = j.response || [];
  if (!list.length) throw new Error("No vehicles on this Tesla account");
  cachedVehicleId = list[0].id;
  console.log(`Auto-discovered vehicle: ${list[0].display_name} (${list[0].vin})`);
  return cachedVehicleId;
}

async function handleVehicle(res) {
  let token = null;
  try { token = await getAccessToken(); } catch (e) { console.error("token error:", e.message); }
  if (!token) {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ demo: true }));
  }
  try {
    const vid = await getVehicleId(token);
    const r = await fetch(`${BASE}/api/1/vehicles/${vid}/vehicle_data`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!r.ok) throw new Error(`Fleet API ${r.status}`);
    const j = await r.json();
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(mapFleetToApp(j.response)));
  } catch (e) {
    console.error("Fleet API error:", e.message);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ demo: true, error: e.message }));
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
    mem.access_token = j.access_token;
    mem.refresh_token = j.refresh_token;
    mem.expires_at = Date.now() + (j.expires_in || 28800) * 1000;
    page(res, "Connected ✓",
      `<div class="card">Your car is linked! <a href="/">Open your dashboard →</a> (badge should say LIVE)</div>
       <div class="card"><b>Make it permanent:</b> free hosting restarts sometimes, and this link lives in memory.
       Copy the refresh token below into Render → buddy-ev-monitor → Environment as
       <code>TESLA_REFRESH_TOKEN</code> so the car stays connected forever:<br><br>
       <code>${esc(j.refresh_token || "(none returned)")}</code></div>`);
  } catch (e) {
    page(res, "Sign-in failed", `<div class="card"><code>${esc(e.message)}</code></div>
      <div class="card"><a href="/auth/login">Try again</a></div>`, 500);
  }
}

const server = http.createServer((req, res) => {
  const p = req.url.split("?")[0];
  if (p === "/api/vehicle") return handleVehicle(res);
  if (p === "/healthz") { res.writeHead(200); return res.end("ok"); }
  if (p === "/.well-known/appspecific/com.tesla.3p.public-key.pem") return servePublicKey(res);
  if (p === "/setup/register") return handleRegister(res);
  if (p === "/auth/login") return handleLogin(res);
  if (p === "/auth/callback") return handleCallback(req, res);
  // static: only index.html exists
  const file = path.join(__dirname, "index.html");
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(500); return res.end("error"); }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(buf);
  });
});

server.listen(PORT, () => console.log(`Tesla Monitor on :${PORT}`));
