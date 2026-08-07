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
  const token = process.env.TESLA_TOKEN;
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

const server = http.createServer((req, res) => {
  if (req.url === "/api/vehicle") return handleVehicle(res);
  if (req.url === "/healthz") { res.writeHead(200); return res.end("ok"); }
  // static: only index.html exists
  const file = path.join(__dirname, "index.html");
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(500); return res.end("error"); }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(buf);
  });
});

server.listen(PORT, () => console.log(`Tesla Monitor on :${PORT}`));
