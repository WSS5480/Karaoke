const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const QRCode = require("qrcode");
const { AsyncLocalStorage } = require("async_hooks");
/* ---------- multi-bar: every request runs "inside" one bar or DJ ----------
   The Dive on 495 is the original and lives at the root URLs (/, /kj, ...).
   Every other bar or DJ lives under /b/<their-name>/ (for example /b/joes-pub/kj).
   ctx carries which one this request is for, so the database and settings
   automatically stay separate without passing a bar around everywhere. */
const ctx = new AsyncLocalStorage();
const T = () => (ctx.getStore() || {}).t || "dive";                 // current bar's slug
const TEN = () => (ctx.getStore() || {}).tenant || DIVE;            // current bar's settings
const BASE = () => (ctx.getStore() || {}).base || "";               // "" for The Dive, "/b/slug" for others
const SK = k => T() === "dive" || k === "session_secret" ? k : "t:" + T() + ":" + k;   // per-bar settings key

const PORT = process.env.PORT || 3000;
const KJ_PIN = process.env.KJ_PIN || "4950";
const BAR_LAT = parseFloat(process.env.BAR_LAT || "26.2183801"), BAR_LNG = parseFloat(process.env.BAR_LNG || "-98.2287714");
const GEOFENCE_M = parseFloat(process.env.GEOFENCE_M || "150");
const QR_TOKEN = process.env.QR_TOKEN || "dive495";
// The Dive on 495: the house bar, set up from Render's environment like before
const DIVE = { slug: "dive", house: true, type: "bar", name: "The Dive on 495", short: "The Dive", city: "McAllen", address: "1116 Pecan Blvd, McAllen, TX",
  lat: BAR_LAT, lng: BAR_LNG, radius: GEOFENCE_M, qr: QR_TOKEN, tags: { Facebook: "@The Dive on 495", Instagram: "@thediveon4954", TikTok: "@thediveon495" } };
const TW_SID = (process.env.TWILIO_ACCOUNT_SID || "").trim(), TW_TOKEN = (process.env.TWILIO_AUTH_TOKEN || "").trim();
let TW_VERIFY = (process.env.TWILIO_VERIFY_SID || "").trim();
if (!/^VA[0-9a-f]{32}$/i.test(TW_VERIFY)) TW_VERIFY = "";   // blank or not a real Service SID: the app finds or creates one
let TW_READY = false;
// phone sign-in needs Twilio set up AND the switch on (KJ page, or PHONE_SIGNIN=off in Render)
async function authOn() {
  if (!TW_READY) return false;
  const s = await db.getSetting("phone_signin");
  return (s || (T() === "dive" ? process.env.PHONE_SIGNIN || "on" : "off")) !== "off";
}
const TW_BASE = () => process.env.TWILIO_VERIFY_BASE || "https://verify.twilio.com";
const twAuth = () => "Basic " + Buffer.from(TW_SID + ":" + TW_TOKEN).toString("base64");
// find the "The Dive" Verify service in this Twilio account, or create it
async function setupTwilio() {
  if (!/^AC[0-9a-f]{32}$/i.test(TW_SID) || TW_TOKEN.length < 20) return;
  try {
    if (!TW_VERIFY) {
      const list = await (await fetch(TW_BASE() + "/v2/Services?PageSize=50", { headers: { Authorization: twAuth() } })).json();
      const found = (list.services || []).find(x => x.friendly_name === "The Dive");
      if (found) TW_VERIFY = found.sid;
      else {
        const r = await fetch(TW_BASE() + "/v2/Services", { method: "POST", headers: { Authorization: twAuth(), "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ FriendlyName: "The Dive" }) });
        const j = await r.json(); if (r.ok && j.sid) TW_VERIFY = j.sid; else console.error("Twilio: couldn't create Verify service:", j.message || r.status);
      }
    }
    TW_READY = !!TW_VERIFY;
  } catch (e) { console.error("Twilio setup failed:", e.message); }
}
let SESSION_SECRET = process.env.SESSION_SECRET || "";
function metersAway(lat, lng) {
  const t = TEN(), LAT = Number(t.lat), LNG = Number(t.lng);
  const R = 6371000, r = x => x * Math.PI / 180, dLat = r(lat - LAT), dLng = r(lng - LNG);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(r(LAT)) * Math.cos(r(lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
const app = express();
app.set("trust proxy", true);
// route /b/<slug>/... to that bar or DJ; everything else is The Dive
app.use(async (req, res, next) => {
  const m = /^\/b\/([a-z0-9][a-z0-9-]{0,38})(\/[^?]*)?(\?.*)?$/.exec(req.url);
  if (!m) { req._ctx = { t: "dive", tenant: DIVE, base: "" }; return ctx.run(req._ctx, next); }
  let t = null;
  try { t = await loadTenant(m[1]); } catch (e) { console.error(e); return res.status(500).send("Database problem. Try again in a minute."); }
  if (!t || t.deleted) return res.status(404).type("html").send(simplePage("Not found", `<h1>We couldn't find that karaoke page</h1><p>Check the link, or ask the host for the QR code.</p>`));
  req.url = (m[2] || "/") + (m[3] || "");
  req._ctx = { t: t.slug, tenant: t, base: "/b/" + t.slug };
  ctx.run(req._ctx, next);
});
// a bar or DJ without an active plan: customers see a short note, staff get sent to Setup to subscribe
app.use(async (req, res, next) => {
  const t = TEN();
  if (t.house) return next();
  refreshPlan(t);
  if (/^\/(setup|api\/setup|api\/billing|terms|logo\.png|[\w-]*icon[\w-]*\.png|[\w-]*apple-touch-icon\.png|[\w-]*manifest\.json|m\/|healthz)/.test(req.path)) return next();
  if (planSummary(t).active) return next();
  if (req.path.startsWith("/api/")) return res.status(402).json({ error: "inactive", message: "This karaoke system isn't active right now. Ask the host." });
  if (/^\/(kj|stats|ads|history|staff|wheel|tv|tent|poster)\b/.test(req.path)) return res.redirect(BASE() + "/setup");
  res.status(402).type("html").send(simplePage(t.name, `<img src="${BASE()}/logo.png" alt=""><h1>${esc(t.name)}</h1><p>Karaoke sign-up isn't open right now. Ask the host, or check back soon.</p>`));
});
/* =====================================================================
   BARS & DJs (multi-bar platform, sold by Stemo Enterprises LLC)
   - Each bar or DJ has a record in the tenants table (name, logo, location, PIN…)
   - Plans/trials/codes live in My Apps (MYAPPS_URL); card payments in Stripe
   ===================================================================== */
const HOST_LIMIT = 2;                                   // host logins per bar/DJ on the Pro plan
const TRIAL_DAYS = 14;
const PRICE_TEXT = process.env.PRICE_TEXT || "$199/month";
const MYAPPS = { url: (process.env.MYAPPS_URL || "").replace(/\/$/, ""), slug: process.env.MYAPPS_SLUG || "karaoke", secret: process.env.MYAPPS_SECRET || "" };
const PLATFORM_KEY = process.env.PLATFORM_KEY || MYAPPS.secret;   // My Apps uses this to list and manage bars
const STRIPE = { key: process.env.STRIPE_SECRET_KEY || "", price: process.env.STRIPE_PRICE_ID || "", wh: process.env.STRIPE_WEBHOOK_SECRET || "" };
const RESERVED = new Set(["dive", "b", "api", "admin", "start", "setup", "kj", "tv", "www", "app", "help", "support", "billing", "karaoke", "stemo"]);
const slugify = s => String(s || "").toLowerCase().replace(/['’]/g, "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 38);
// names go into pages and scripts: keep them plain text
const cleanName = (s, max) => clean(s, max).replace(/[<>"\\`$\{\}]/g, "").replace(/'/g, "’");
const today = () => new Date().toISOString().slice(0, 10);
const addDays = n => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

function hashPin(pin) { const salt = crypto.randomBytes(8).toString("hex"); return salt + ":" + crypto.scryptSync(String(pin), salt, 32).toString("hex"); }
function pinMatches(pin, stored) {
  if (!pin || !stored || !stored.includes(":")) return false;
  const [salt, h] = stored.split(":"), got = crypto.scryptSync(String(pin), salt, 32).toString("hex");
  return got.length === h.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(h));
}

const tenantCache = new Map();
async function loadTenant(slug) {
  const c = tenantCache.get(slug);
  if (c && Date.now() - c.at < 30000) return c.t;
  const t = await db.getTenant(slug); tenantCache.set(slug, { t, at: Date.now() }); return t;
}
async function saveTenant(t) { t.v = (t.v || 0) + 1; await db.saveTenant(t); tenantCache.delete(t.slug); pageCache.clear(); }
function tenantPublic(t) { return { slug: t.slug, house: !!t.house, type: t.type || "bar", name: t.name, short: t.short, city: t.city || "", venue: t.venue || "" }; }
// location check works only once the bar/DJ has a location saved
function geofenceActive(v) { if (v === "off") return false; const t = TEN(); return t.lat != null && t.lat !== "" && Number.isFinite(Number(t.lat)); }

/* ---------- plan: is this bar allowed to run tonight? ---------- */
function planSummary(t) {
  if (t.house) return { active: true, house: true, label: "House account" };
  if (t.disabled) return { active: false, label: "Turned off by Stemo Enterprises" };
  const s = t.stripe || {};
  if (["active", "trialing", "past_due"].includes(s.status)) return { active: true, paid: true, label: "Pro · paid monthly", status: s.status };
  const p = t.plan || {};
  if (p.plan === "pro" && !p.expires_on) return { active: true, label: "Pro" + (p.source === "manual" ? " (set by Stemo)" : "") };
  if (p.plan === "pro" && p.expires_on >= today()) {
    const left = Math.max(0, Math.round((new Date(p.expires_on) - new Date(today())) / 864e5));
    return { active: true, trial: p.source === "trial", code: p.source === "code", expires_on: p.expires_on, days_left: left,
      label: (p.source === "trial" ? "Free trial" : p.source === "code" ? "Pro (code)" : "Pro") + " · " + left + " day" + (left === 1 ? "" : "s") + " left" };
  }
  return { active: false, ended: !!p.expires_on, label: p.source === "trial" ? "Free trial ended" : "Not active" };
}
async function myApps(pathname, body) {
  if (!MYAPPS.url || !MYAPPS.secret) return null;
  try {
    const r = await fetch(MYAPPS.url + pathname, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: MYAPPS.slug, secret: MYAPPS.secret, ...body }), signal: AbortSignal.timeout(15000) });
    const j = await r.json().catch(() => ({}));
    return { httpOk: r.ok, ...j };
  } catch (e) { console.error("My Apps unreachable:", e.message); return null; }
}
const tkey = slug => "bar:" + slug;
// pick up changes made in the My Apps manager office (extend, cancel…) in the background
const planChecked = new Map();
function refreshPlan(t) {
  if (t.house || !MYAPPS.url || Date.now() - (planChecked.get(t.slug) || 0) < 10 * 60000) return;
  planChecked.set(t.slug, Date.now());
  myApps("/api/v1/plan", { tenant: tkey(t.slug) }).then(async j => {
    if (!j || !j.ok) return;
    const fresh = await db.getTenant(t.slug); if (!fresh) return;
    const p = { plan: j.plan, expires_on: j.expires_on ? String(j.expires_on).slice(0, 10) : null, source: j.source || null };
    if (JSON.stringify(p) !== JSON.stringify({ plan: (fresh.plan || {}).plan, expires_on: (fresh.plan || {}).expires_on || null, source: (fresh.plan || {}).source || null })) { fresh.plan = p; await saveTenant(fresh); }
  }).catch(() => {});
}

/* ---------- branding: other bars get The Dive's pages with their own name, logo and links ---------- */
const PATH_RE = /(["'`(])\/(?=(?:api\/|kj\b|wall\b|tv\b|tent\b|poster\b|history\b|stats\b|ads\b|terms\b|staff\b|wheel\b|setup\b|s\/|m\/|qr\.svg|logo\.png|songs\.json|sw\.js|install\.js|zoom\.js|[\w-]*manifest\.json|[\w-]*icon[\w-]*\.png|[\w-]*apple-touch-icon\.png|\?|["'`)]))/g;
function brand(html, t, base, host) {
  if (t.house) return html;
  const name = t.name, short = t.short || t.name, tagWord = (short || name).replace(/[^A-Za-z0-9]/g, ""), city = t.city || "";
  const tags = Object.assign({ Facebook: "@" + name, Instagram: "@" + tagWord.toLowerCase(), TikTok: "@" + tagWord.toLowerCase() }, t.tags || {});
  let h = html.replace(PATH_RE, (m, q) => q + base + "/");
  h = h.replace(/const LOGO_SRC = "[^"]*"/, `const LOGO_SRC = "${base}/logo.png"`)
       .replace(/(<div class="qrcorner"[^>]*>)<svg[\s\S]*?<\/svg>/, `$1<img src="${base}/qr.svg" alt="QR code to sign up" style="display:block;width:100%">`)
       .replace(/const DIVE_TAGS = \{[^}]*\};/, "const DIVE_TAGS = " + JSON.stringify(tags) + ";")
       .replace(/<a href="https:\/\/www\.facebook\.com\/[^"]*"[^>]*>Facebook<\/a>/g, "Facebook").replace(/<a href="https:\/\/www\.instagram\.com\/[^"]*"[^>]*>Instagram<\/a>/g, "Instagram")
       .replace(/"kj_pin"/g, `"kj_pin_${t.slug}"`).replace(/(["'])dive_/g, `$1dive_${t.slug}_`)
       .replace(/the-dive-karaoke\.onrender\.com/g, (host || "") + base)
       .replace(/1116 Pecan Blvd, McAllen, (Texas|TX)/g, t.address || name)
       .replace(/Hidalgo County, Texas/g, "the county where " + short + " is located").replace(/a Hidalgo County justice court/g, "the local justice court")
       .replace(/ · McAllen, TX/g, city ? " · " + city : "").replace(/McAllen, (TX|Texas)/g, city || "")
       .replace(/#TheDiveOn495/g, "#" + tagWord).replace(/ ?#McAllen/g, city ? " #" + city.replace(/[^A-Za-z0-9]/g, "") : "")
       .replace(/The Dive on 495/g, name).replace(/The Dive/g, short)
       .replace(/\bDive (KJ|Staff|Stats|Ads|Wheel|TV|History|Fame)\b/g, short + " $1")
       .replace(/Escanea para cantar/g, "Escanea para cantar");
  return h;
}
const pageCache = new Map();
function rawPage(file, appMeta) {
  let html = fs.readFileSync(path.join(__dirname, file), "utf8");
  if (appMeta) {
    html = html.replace(/<link rel="(manifest|apple-touch-icon)"[^>]*>\s*/g, "").replace(/<meta name="apple-mobile-web-app-(title|capable)"[^>]*>\s*/g, "");
    const tags = `<link rel="manifest" href="/m/${appMeta.key}.json">\n<link rel="apple-touch-icon" href="/${appMeta.key}-apple-touch-icon.png">\n<meta name="apple-mobile-web-app-capable" content="yes">\n<meta name="mobile-web-app-capable" content="yes">\n<meta name="apple-mobile-web-app-title" content="${appMeta.short}">\n<script src="/install.js" defer></script>\n`;
    html = html.replace("</head>", tags + "</head>");
  }
  return html;
}
function sendPage(req, res, file, appMeta, type) {
  const t = TEN(), key = t.slug + "|" + file + "|" + (t.v || 0) + "|" + req.get("host");
  let h = pageCache.get(key);
  if (h == null) { h = rawPage(file, appMeta); if (!t.house) h = brand(h, t, BASE(), req.get("host")); pageCache.set(key, h); }
  res.type(type || "html").set("Cache-Control", "no-cache").send(h);
}
// logo + app icons: The Dive's files, or the bar's own uploaded logo
function sendLogo(req, res, file) {
  const t = TEN();
  if (t.house) return res.sendFile(path.join(__dirname, file));
  const m = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(t.logo || "");
  if (!m) return res.sendFile(path.join(__dirname, "default-logo.png"));
  res.type(m[1]).set("Cache-Control", "public, max-age=300").send(Buffer.from(m[2], "base64"));
}
const simplePage = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{margin:0;background:#0a0c0a;color:#eef3ee;font-family:system-ui,-apple-system,sans-serif;display:grid;place-items:center;min-height:100vh;padding:24px;box-sizing:border-box;text-align:center}main{max-width:420px}img{width:140px;border-radius:16px}h1{font-family:Georgia,serif;font-size:26px;margin:16px 0 6px}p{color:#9fae9f;line-height:1.5}a{color:#5fd36e}</style></head><body><main>${body}</main></body></html>`;

/* ---------- Stripe (card payments for the $199/mo plan) — needs no npm package ---------- */
async function stripeApi(pathname, form) {
  const r = await fetch("https://api.stripe.com/v1/" + pathname, { method: "POST", headers: { Authorization: "Bearer " + STRIPE.key, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form), signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || "Stripe error " + r.status);
  return j;
}
function stripeSigOk(raw, header) {
  if (!STRIPE.wh || !header) return false;
  const parts = Object.fromEntries(String(header).split(",").map(x => x.split("=")).filter(x => x.length === 2).map(([k, v]) => [k, v]));
  const sigs = String(header).split(",").filter(x => x.startsWith("v1=")).map(x => x.slice(3));
  if (!parts.t || !sigs.length || Math.abs(Date.now() / 1000 - Number(parts.t)) > 600) return false;
  const want = crypto.createHmac("sha256", STRIPE.wh).update(parts.t + "." + raw).digest("hex");
  return sigs.some(s => s.length === want.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(want)));
}
app.post("/api/stripe/webhook", express.raw({ type: "*/*", limit: "1mb" }), async (req, res) => {
  const raw = req.body ? req.body.toString("utf8") : "";
  if (!stripeSigOk(raw, req.headers["stripe-signature"])) return res.status(400).send("bad signature");
  let ev; try { ev = JSON.parse(raw); } catch (e) { return res.status(400).send("bad json"); }
  try {
    const o = ev.data && ev.data.object || {};
    const slug = (o.metadata && o.metadata.tenant) || o.client_reference_id;
    const t = slug && await db.getTenant(slug);
    if (t) {
      if (ev.type === "checkout.session.completed") t.stripe = { customer: o.customer, sub: o.subscription, status: "active" };
      else if (/^customer\.subscription\.(created|updated|deleted)$/.test(ev.type)) t.stripe = { ...(t.stripe || {}), customer: o.customer, sub: o.id, status: ev.type.endsWith("deleted") ? "canceled" : o.status };
      await saveTenant(t);
      const on = ["active", "trialing", "past_due"].includes(t.stripe.status);
      myApps("/api/v1/tenant-paid", { tenant: tkey(t.slug), tenantName: t.name, active: on });
      console.log(`Stripe: ${t.name} subscription ${t.stripe.status}`);
    }
  } catch (e) { console.error("webhook:", e.message); }
  res.json({ received: true });
});

app.use("/api/kj/promos", express.json({ limit: "1mb" })); // ad pictures
app.use(["/api/setup", "/api/start"], express.json({ limit: "1mb" })); // logos
app.use(express.json({ limit: "20kb" }));
// reading a request body loses track of which bar it is for, so put it back
app.use((req, res, next) => req._ctx ? ctx.run(req._ctx, next) : next());

/* ---------- storage: Postgres on Render, memory when run locally ---------- */
let db;
const DB_URL = (process.env.DATABASE_URL || "").trim();
const DB_OK = /^postgres(ql)?:\/\/[^\s]+@[^\s/]+\/\S+$/.test(DB_URL);
if (DB_URL && !DB_OK) console.error(`DATABASE_URL doesn't look like a Postgres link (it should start with postgresql://). It starts with "${DB_URL.slice(0, 8)}" and is ${DB_URL.length} characters. Using in-memory storage until it's fixed.`);
if (DB_OK) {
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: DB_URL, ssl: process.env.PGSSL === "off" ? false : { rejectUnauthorized: false } });
  const Q = (sql, args) => pool.query(sql, args);
  db = {
    async init() {
      await Q(`CREATE TABLE IF NOT EXISTS signups (
        id SERIAL PRIMARY KEY, name TEXT NOT NULL, song TEXT NOT NULL, artist TEXT DEFAULT '',
        device TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', position DOUBLE PRECISION NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), done_at TIMESTAMPTZ)`);
      await Q(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);
      await Q(`ALTER TABLE signups ADD COLUMN IF NOT EXISTS rating INT`);
      await Q(`ALTER TABLE signups ADD COLUMN IF NOT EXISTS public BOOLEAN NOT NULL DEFAULT false`);
      await Q(`ALTER TABLE signups ADD COLUMN IF NOT EXISTS posted_to TEXT NOT NULL DEFAULT ''`);
      // multi-bar: every sign-up belongs to one bar or DJ ("dive" = The Dive on 495, the original)
      await Q(`ALTER TABLE signups ADD COLUMN IF NOT EXISTS tenant TEXT NOT NULL DEFAULT 'dive'`);
      await Q(`CREATE INDEX IF NOT EXISTS signups_tenant_status ON signups (tenant, status)`);
      await Q(`CREATE INDEX IF NOT EXISTS signups_tenant_device ON signups (tenant, device)`);
      await Q(`CREATE TABLE IF NOT EXISTS tenants (slug TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await Q(`CREATE TABLE IF NOT EXISTS customers (id SERIAL PRIMARY KEY, phone TEXT UNIQUE NOT NULL, name TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_seen TIMESTAMPTZ)`);
    },
    async customerByPhone(p) { return (await Q(`SELECT * FROM customers WHERE phone=$1`, [p])).rows[0]; },
    async customer(id) { return (await Q(`SELECT * FROM customers WHERE id=$1`, [id])).rows[0]; },
    async addCustomer(p) { return (await Q(`INSERT INTO customers (phone) VALUES ($1) ON CONFLICT (phone) DO UPDATE SET last_seen=now() RETURNING *`, [p])).rows[0]; },
    async setCustomerName(id, n) { await Q(`UPDATE customers SET name=$2, last_seen=now() WHERE id=$1`, [id, n]); },
    async moveDevice(from, to) { await Q(`UPDATE signups SET device=$2 WHERE device=$1 AND tenant=$3`, [from, to, T()]); },
    async mineAll(d, sort) { return (await Q(`SELECT * FROM signups WHERE tenant=$2 AND device=$1 AND done_at IS NOT NULL AND status IN ('done','archived') ORDER BY ${sort === "top" ? "rating DESC NULLS LAST, done_at DESC" : "done_at DESC"} LIMIT 200`, [d, T()])).rows; },
    async sungSince(t) { return (await Q(`SELECT name, song, artist, device, rating, public, done_at FROM signups WHERE tenant=$2 AND done_at IS NOT NULL AND status IN ('done','archived') AND done_at >= $1 ORDER BY done_at`, [new Date(t), T()])).rows; },
    async lastSung(d) { return (await Q(`SELECT * FROM signups WHERE tenant=$2 AND device=$1 AND status IN ('done','archived') AND done_at > now() - interval '12 hours' ORDER BY done_at DESC LIMIT 1`, [d, T()])).rows[0]; },
    async rate(id, rating, pub) { await Q(`UPDATE signups SET rating=$2, public=$3 WHERE id=$1 AND tenant=$4`, [id, rating, pub, T()]); },
    async setPosted(id, v) { await Q(`UPDATE signups SET posted_to=$2 WHERE id=$1 AND tenant=$3`, [id, v, T()]); },
    async history(o) {
      const where = [`done_at IS NOT NULL`, `tenant=$1`], args = [T()];
      if (o.onlyPublic) where.push(`public`);
      if (o.q) { args.push('%' + o.q.toLowerCase() + '%'); where.push(`(lower(name) LIKE $${args.length} OR lower(song) LIKE $${args.length} OR lower(artist) LIKE $${args.length})`); }
      args.push(o.limit);
      const order = o.sort === "top" ? `rating DESC NULLS LAST, done_at DESC` : `done_at DESC`;
      return (await Q(`SELECT * FROM signups WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT $${args.length}`, args)).rows;
    },
    async active() { return (await Q(`SELECT * FROM signups WHERE tenant=$1 AND status IN ('up','queued') ORDER BY (status='up') DESC, position`, [T()])).rows; },
    async done(limit) { return (await Q(`SELECT * FROM signups WHERE tenant=$2 AND status='done' ORDER BY done_at DESC LIMIT $1`, [limit, T()])).rows; },
    async byDevice(d) { return (await Q(`SELECT * FROM signups WHERE tenant=$2 AND device=$1 AND status IN ('up','queued') LIMIT 1`, [d, T()])).rows[0]; },
    async add(r) { return (await Q(`INSERT INTO signups (name,song,artist,device,tenant,position) VALUES ($1,$2,$3,$4,$5,(SELECT COALESCE(MAX(position),0)+1 FROM signups WHERE tenant=$5)) RETURNING *`, [r.name, r.song, r.artist, r.device, T()])).rows[0]; },
    async setStatus(id, s) { await Q(`UPDATE signups SET status=$2, done_at=CASE WHEN $2='done' THEN now() ELSE done_at END WHERE id=$1 AND tenant=$3`, [id, s, T()]); },
    async rename(id, n) { await Q(`UPDATE signups SET name=$2 WHERE id=$1 AND tenant=$3`, [id, n, T()]); },
    async setPos(id, p) { await Q(`UPDATE signups SET position=$2 WHERE id=$1 AND tenant=$3`, [id, p, T()]); },
    async get(id) { return (await Q(`SELECT * FROM signups WHERE id=$1 AND tenant=$2`, [id, T()])).rows[0]; },
    async newNight() { await Q(`UPDATE signups SET status='archived' WHERE tenant=$1 AND status IN ('up','queued','done')`, [T()]); },
    async getSetting(k) { const r = (await Q(`SELECT value FROM settings WHERE key=$1`, [SK(k)])).rows[0]; return r ? r.value : null; },
    async setSetting(k, v) { await Q(`INSERT INTO settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2`, [SK(k), v]); },
    // bars and DJs that use the system (The Dive itself is built in, not stored here)
    async getTenant(slug) { const r = (await Q(`SELECT data, created_at FROM tenants WHERE slug=$1`, [slug])).rows[0]; return r ? { ...JSON.parse(r.data), slug, created_at: r.created_at } : null; },
    async saveTenant(t) { const { slug, created_at, ...data } = t; await Q(`INSERT INTO tenants (slug,data) VALUES ($1,$2) ON CONFLICT (slug) DO UPDATE SET data=$2`, [slug, JSON.stringify(data)]); },
    async listTenants() { return (await Q(`SELECT slug, data, created_at FROM tenants ORDER BY created_at DESC`)).rows.map(r => ({ ...JSON.parse(r.data), slug: r.slug, created_at: r.created_at })); },
    async tenantCounts() { return Object.fromEntries((await Q(`SELECT tenant, count(*)::int n, max(done_at) last FROM signups WHERE done_at IS NOT NULL GROUP BY tenant`)).rows.map(r => [r.tenant, { songs: r.n, last: r.last }])); }
  };
} else {
  console.warn("DATABASE_URL not set: using in-memory storage (data resets on restart).");
  let rows = [], seq = 0, settings = {}, tenants = {};
  const now = () => new Date().toISOString();
  const mine = r => (r.tenant || "dive") === T();
  db = {
    async init() {},
    customers: [],
    async customerByPhone(p) { return this.customers.find(c => c.phone === p); },
    async customer(id) { return this.customers.find(c => c.id === id); },
    async addCustomer(p) { let c = this.customers.find(x => x.phone === p); if (!c) { c = { id: this.customers.length + 1, phone: p, name: "", created_at: now() }; this.customers.push(c); } return c; },
    async setCustomerName(id, n) { const c = this.customers.find(x => x.id === id); if (c) c.name = n; },
    async moveDevice(from, to) { rows.forEach(r => { if (mine(r) && r.device === from) r.device = to; }); },
    async mineAll(d, sort) { return rows.filter(r => mine(r) && r.device === d && r.done_at && (r.status === "done" || r.status === "archived")).sort(sort === "top" ? (a, b) => (b.rating ?? -1) - (a.rating ?? -1) || b.done_at.localeCompare(a.done_at) : (a, b) => b.done_at.localeCompare(a.done_at)).slice(0, 200); },
    async sungSince(t) { return rows.filter(r => mine(r) && r.done_at && (r.status === "done" || r.status === "archived") && Date.parse(r.done_at) >= t).sort((a, b) => a.done_at.localeCompare(b.done_at)); },
    async lastSung(d) { const cut = Date.now() - 12 * 3600e3; return rows.filter(r => mine(r) && r.device === d && (r.status === "done" || r.status === "archived") && r.done_at && Date.parse(r.done_at) > cut).sort((a, b) => b.done_at.localeCompare(a.done_at))[0]; },
    async rate(id, rating, pub) { const r = rows.find(x => x.id === id && mine(x)); if (r) { r.rating = rating; r.public = pub; } },
    async setPosted(id, v) { const r = rows.find(x => x.id === id && mine(x)); if (r) r.posted_to = v; },
    async history(o) {
      let l = rows.filter(r => mine(r) && r.done_at && (!o.onlyPublic || r.public));
      if (o.q) { const q = o.q.toLowerCase(); l = l.filter(r => (r.name + " " + r.song + " " + r.artist).toLowerCase().includes(q)); }
      l.sort(o.sort === "top" ? (a, b) => (b.rating ?? -1) - (a.rating ?? -1) || b.done_at.localeCompare(a.done_at) : (a, b) => b.done_at.localeCompare(a.done_at));
      return l.slice(0, o.limit);
    },
    async active() { return rows.filter(r => mine(r) && (r.status === "up" || r.status === "queued")).sort((a, b) => (b.status === "up") - (a.status === "up") || a.position - b.position); },
    async done(limit) { return rows.filter(r => mine(r) && r.status === "done").sort((a, b) => b.done_at.localeCompare(a.done_at)).slice(0, limit); },
    async byDevice(d) { return rows.find(r => mine(r) && r.device === d && (r.status === "up" || r.status === "queued")); },
    async add(r) { const row = { ...r, tenant: T(), id: ++seq, status: "queued", position: Math.max(0, ...rows.filter(mine).map(x => x.position)) + 1, created_at: now(), done_at: null, rating: null, public: false }; rows.push(row); return row; },
    async setStatus(id, s) { const r = rows.find(x => x.id === id && mine(x)); if (r) { r.status = s; if (s === "done") r.done_at = now(); } },
    async rename(id, n) { const r = rows.find(x => x.id === id && mine(x)); if (r) r.name = n; },
    async setPos(id, p) { const r = rows.find(x => x.id === id && mine(x)); if (r) r.position = p; },
    async get(id) { return rows.find(x => x.id === id && mine(x)); },
    async newNight() { rows.forEach(r => { if (mine(r) && r.status !== "removed") r.status = "archived"; }); },
    async getSetting(k) { return settings[SK(k)] ?? null; },
    async setSetting(k, v) { settings[SK(k)] = v; },
    async getTenant(slug) { return tenants[slug] ? { ...tenants[slug] } : null; },
    async saveTenant(t) { tenants[t.slug] = { created_at: (tenants[t.slug] || {}).created_at || now(), ...t }; },
    async listTenants() { return Object.values(tenants).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))); },
    async tenantCounts() { const o = {}; rows.filter(r => r.done_at).forEach(r => { const k = r.tenant || "dive"; o[k] = o[k] || { songs: 0, last: null }; o[k].songs++; if (!o[k].last || r.done_at > o[k].last) o[k].last = r.done_at; }); return o; }
  };
}

/* ---------- helpers ---------- */
const clean = (s, max) => String(s || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const publicRow = r => ({ id: r.id, name: r.name, song: r.song, artist: r.artist, status: r.status });
const NETS = ["Facebook", "Instagram", "TikTok"];
const postedList = r => String((r && r.posted_to) || "").split(",").filter(x => NETS.includes(x));
const kjRow = r => ({ ...publicRow(r), rating: r.rating || null, posted: postedList(r) });
function device(req, res) {
  let d = (req.headers.cookie || "").split(/;\s*/).map(c => c.split("=")).find(([k]) => k === "dive_device");
  d = d && /^[a-f0-9]{32}$/.test(d[1]) ? d[1] : null;
  if (!d) {
    d = crypto.randomBytes(16).toString("hex");
    res.append("Set-Cookie", `dive_device=${d}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly${req.secure ? "; Secure" : ""}`);
  }
  return d;
}
function cookieVal(req, k) { const c = (req.headers.cookie || "").split(/;\s*/).map(x => x.split("=")).find(([n]) => n === k); return c ? c[1] : null; }
const sign = v => crypto.createHmac("sha256", SESSION_SECRET).update(String(v)).digest("hex").slice(0, 32);
function currentUser(req) {
  const v = cookieVal(req, "dive_user"); if (!v) return null;
  const [id, mac] = v.split(".");
  return mac && mac.length === 32 && crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(sign(id))) ? parseInt(id, 10) : null;
}
function setUserCookie(req, res, id) {
  res.append("Set-Cookie", `dive_user=${id}.${sign(id)}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly${req.secure ? "; Secure" : ""}`);
}
// who "owns" a sign-up: the signed-in customer, otherwise this phone's browser
// one profile per phone: the phone's first sign-up sets its name; a phone links to at most one phone-number account
async function getProfile(dev) { try { return JSON.parse((await db.getSetting("profile:" + dev)) || "null"); } catch (e) { return null; } }
async function setProfile(dev, p) { await db.setSetting("profile:" + dev, JSON.stringify(p)); }
function owner(req, res) { const u = currentUser(req); return u ? "c" + u : device(req, res); }
function normPhone(p) {
  const raw = String(p || "").trim(), d = raw.replace(/\D/g, "");
  if (raw.startsWith("+") && d.length >= 10 && d.length <= 15) return "+" + d;
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d.startsWith("1")) return "+" + d;
  return null;
}
async function twilio(path, form) {
  const r = await fetch(`${TW_BASE()}/v2/Services/${TW_VERIFY}/${path}`, {
    method: "POST", body: new URLSearchParams(form),
    headers: { Authorization: twAuth(), "Content-Type": "application/x-www-form-urlencoded" }
  });
  return { ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) };
}
function pinOk(req) {
  const p = String(req.headers["x-kj-pin"] || "");
  return p.length === KJ_PIN.length && crypto.timingSafeEqual(Buffer.from(p), Buffer.from(KJ_PIN));
}
const hits = new Map();
function rateLimited(ip) {
  const t = Date.now(), list = (hits.get(ip) || []).filter(x => t - x < 60000);
  list.push(t); hits.set(ip, list);
  return list.length > 6;
}
const wrap = fn => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ error: "Something went wrong on our end. Try again." }); });
function siteUrl(req) { return (process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, ""); }


// pause: "on" = until resumed, a number = paused until that time (ms)
async function pauseState() {
  const v = await db.getSetting("paused");
  if (!v || v === "off") return { paused: false, until: null };
  if (v === "on") return { paused: true, until: null };
  const t = Number(v);
  return t > Date.now() ? { paused: true, until: t } : { paused: false, until: null };
}
/* ---------- singer API ---------- */
app.get("/api/queue", wrap(async (req, res) => {
  const d = owner(req, res);
  const list = await db.active();
  const open = (await db.getSetting("open")) !== "no";
  const mine = list.find(r => r.device === d);
  const last = mine ? null : await db.lastSung(d);
  const geofence = geofenceActive(await db.getSetting("geofence")), ps = await pauseState();
  res.json({ venue: TEN().venue || "", multi: (await db.getSetting("multi")) === "on", open, geofence, paused: ps.paused, pausedUntil: ps.until, queue: list.map(publicRow), mine: mine ? { ...publicRow(mine), spot: list.indexOf(mine) } : null,
    last: last ? { ...publicRow(last), rating: last.rating, public: !!last.public } : null });
}));

app.post("/api/signup", wrap(async (req, res) => {
  const dev = device(req, res), uid = currentUser(req), d = uid ? "c" + uid : dev;
  if ((await db.getSetting("open")) === "no") return res.status(403).json({ error: "Sign-ups are closed for tonight." });
  { const ps = await pauseState(); if (ps.paused) return res.status(403).json({ error: ps.until ? "Sign-ups are paused until " + new Date(ps.until).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: ZONE() }) + ". Try again then." : "Sign-ups are paused for a bit. Try again soon." }); }
  if ((await authOn()) && !currentUser(req)) return res.status(401).json({ error: "signin", message: "Sign in with your phone number first." });
  if (rateLimited(req.ip)) return res.status(429).json({ error: "Too many tries. Wait a minute and try again." });
  if (!(await termsOk(dev))) return res.status(428).json({ error: "terms", message: "Please read and agree to the Terms to sign up." });
  if (geofenceActive(await db.getSetting("geofence")) && req.body.qr !== TEN().qr) {
    const lat = Number(req.body.lat), lng = Number(req.body.lng), acc = Math.min(Math.max(Number(req.body.acc) || 0, 0), 200);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(403).json({ error: "location", message: "Turn on location so we can see you're at " + TEN().short + ", or scan the QR code." });
    const away = metersAway(lat, lng);
    if (away - acc > (Number(TEN().radius) || 150)) return res.status(403).json({ error: "far", miles: Math.round(away / 1609.34 * 10) / 10, message: "You need to be at " + TEN().short + " to sign up." });
  }
  const profile = await getProfile(dev), cust = uid ? await db.customer(uid) : null;
  const name = (cust && cust.name) || (profile && profile.name) || clean(req.body.name, 30), song = clean(req.body.song, 80), artist = clean(req.body.artist, 60);
  if (!name) return res.status(400).json({ error: "Enter your name or stage name." });
  if (!profile) await setProfile(dev, { name, customer: uid || null });
  if (!song) return res.status(400).json({ error: "Enter the song you want to sing." });
  // one song in line per person unless the host turned on multiple sign-ups
  const multi = (await db.getSetting("multi")) === "on";
  if (!multi && await db.byDevice(d)) return res.status(409).json({ error: "already", message: "You're already on the list. Cancel your song to pick a different one." });
  if (multi && (await db.active()).some(r => r.device === d && r.song.toLowerCase() === song.toLowerCase())) return res.status(409).json({ error: "already", message: "That song is already on the list for you." });
  const row = await db.add({ name, song, artist, device: d });
  res.json({ ok: true, id: row.id });
}));

/* ---------- favorites + practice list (per person, saved on the server) ---------- */
async function getLists(o) { try { const v = JSON.parse((await db.getSetting("lists:" + o)) || "{}"); return { fav: v.fav || [], practice: v.practice || [] }; } catch (e) { return { fav: [], practice: [] }; } }
// most-sung songs at this bar (last 90 days), for "For you" suggestions
const popCaches = new Map();   // per bar
app.get("/api/popular", wrap(async (req, res) => {
  let popCache = popCaches.get(T()) || { at: 0, items: [] };
  if (Date.now() - popCache.at > 10 * 60000) {
    const counts = new Map();
    for (const r of await db.sungSince(Date.now() - 90 * 864e5)) {
      const k = (r.song + "|" + (r.artist || "")).toLowerCase(), c = counts.get(k) || { song: r.song, artist: r.artist || "", count: 0 };
      c.count++; counts.set(k, c);
    }
    popCache = { at: Date.now(), items: [...counts.values()].sort((a, b) => b.count - a.count).slice(0, 40) }; popCaches.set(T(), popCache);
  }
  res.json({ items: popCache.items });
}));
app.get("/api/lists", wrap(async (req, res) => res.json(await getLists(owner(req, res)))));
app.post("/api/lists", wrap(async (req, res) => {
  const o = owner(req, res), b = req.body || {}, list = b.list === "practice" ? "practice" : b.list === "fav" ? "fav" : null;
  if (!list) return res.status(400).json({ error: "Pick a list." });
  const song = clean(b.song, 80), artist = clean(b.artist, 60);
  if (!song) return res.status(400).json({ error: "Enter a song." });
  const L = await getLists(o), key = x => (x.song + "|" + (x.artist || "")).toLowerCase(), k = key({ song, artist });
  L[list] = L[list].filter(x => key(x) !== k);
  if (b.op !== "remove") { if (L[list].length >= 200) return res.status(400).json({ error: "That list is full (200 songs). Remove one first." }); L[list].unshift({ song, artist, at: new Date().toISOString() }); }
  await db.setSetting("lists:" + o, JSON.stringify(L)); res.json(L);
}));

app.post("/api/cancel", wrap(async (req, res) => {
  const d = owner(req, res), mine = await db.byDevice(d);
  if (!mine) return res.status(404).json({ error: "You're not on the list right now." });
  await db.setStatus(mine.id, "removed");
  res.json({ ok: true });
}));

app.post("/api/rate", wrap(async (req, res) => {
  const d = owner(req, res);
  let last;
  if (req.body.id) { const r = await db.get(parseInt(req.body.id, 10)); last = r && r.device === d && r.done_at ? r : null; }
  else last = await db.lastSung(d);
  if (!last) return res.status(404).json({ error: "Rate your song after you sing." });
  const rating = parseInt(req.body.rating, 10);
  if (!(rating >= 1 && rating <= 5)) return res.status(400).json({ error: "Pick 1 to 5 stars." });
  await db.rate(last.id, rating, !!req.body.public);
  res.json({ ok: true, id: last.id });
}));
const histRow = r => ({ id: r.id, name: r.name, song: r.song, artist: r.artist, rating: r.rating, public: !!r.public, at: r.done_at, posted: postedList(r) });
// customer tells us they shared a song (tapped an icon and the share went through)
app.post("/api/posted", wrap(async (req, res) => {
  const d = owner(req, res), r = await db.get(parseInt(req.body.id, 10));
  if (!r || r.device !== d) return res.status(404).json({ error: "Song not found." });
  const net = NETS.includes(req.body.net) ? req.body.net : null; if (!net) return res.status(400).json({ error: "Pick an app." });
  const list = postedList(r); if (!list.includes(net)) { list.push(net); await db.setPosted(r.id, list.join(",")); }
  res.json({ ok: true, posted: list });
}));
app.get("/api/mine", wrap(async (req, res) => {
  const d = owner(req, res);
  res.json({ items: (await db.mineAll(d, req.query.sort === "top" ? "top" : "new")).map(histRow) });
}));
app.get("/api/wall", wrap(async (req, res) => {
  res.json({ items: (await db.history({ onlyPublic: true, sort: req.query.sort === "top" ? "top" : "new", limit: 100 })).map(histRow) });
}));

/* ---------- customer accounts: phone number + text code (Twilio Verify) ---------- */
// user agreement: which version this phone agreed to, and when (kept as a record)
const TERMS_V = "2026-10-01";
async function termsOk(dev) { try { return JSON.parse((await db.getSetting("terms:" + dev)) || "{}").v === TERMS_V; } catch (e) { return false; } }
async function recordTerms(req, dev) { const u = currentUser(req); await db.setSetting("terms:" + dev, JSON.stringify({ v: TERMS_V, at: new Date().toISOString(), ip: req.ip, customer: u || null, ua: String(req.headers["user-agent"] || "").slice(0, 200) })); }
app.post("/api/terms", wrap(async (req, res) => {
  if (req.body.v !== TERMS_V || req.body.agree !== true) return res.status(400).json({ error: "Check the box to agree." });
  await recordTerms(req, device(req, res)); res.json({ ok: true, v: TERMS_V });
}));
app.get("/api/me", wrap(async (req, res) => {
  const u = currentUser(req), c = u ? await db.customer(u) : null, p = await getProfile(device(req, res));
  const dv = device(req, res);
  res.json({ terms: TERMS_V, termsOk: await termsOk(dv), auth: await authOn(), user: c ? { name: c.name, phone: "•••-•••-" + c.phone.slice(-4) } : null, profileName: (c && c.name) || (p && p.name) || null });
}));
const textHits = new Map();
app.post("/api/auth/start", wrap(async (req, res) => {
  if (!(await authOn())) return res.status(400).json({ error: "Phone sign-in is off right now." });
  const phone = normPhone(req.body.phone);
  if (!phone) return res.status(400).json({ error: "Enter a 10-digit phone number." });
  const t = Date.now(), k = phone + "|" + req.ip, l = (textHits.get(k) || []).filter(x => t - x < 600000);
  if (l.length >= 3) return res.status(429).json({ error: "Too many codes sent. Wait 10 minutes and try again." });
  l.push(t); textHits.set(k, l);
  const r = await twilio("Verifications", { To: phone, Channel: "sms", Locale: req.body.lang === "es" ? "es" : "en" });
  if (!r.ok) { console.error("twilio start", r.status, r.body && r.body.message); return res.status(400).json({ error: "Couldn't text that number. Check it and try again." }); }
  res.json({ ok: true });
}));
app.post("/api/auth/check", wrap(async (req, res) => {
  if (!(await authOn())) return res.status(400).json({ error: "Phone sign-in is off right now." });
  const phone = normPhone(req.body.phone), code = String(req.body.code || "").replace(/\D/g, "");
  if (!phone || code.length < 4) return res.status(400).json({ error: "Enter the code from your text." });
  const r = await twilio("VerificationCheck", { To: phone, Code: code });
  if (!r.ok || r.body.status !== "approved") return res.status(400).json({ error: "That code didn't work. Check it or send a new one." });
  const dev = device(req, res), p = await getProfile(dev), c = await db.addCustomer(phone);
  if (p && p.customer && p.customer !== c.id) return res.status(409).json({ error: "This phone is already set up for " + (p.name || "someone else") + ". One person per phone. Ask the KJ if this is a mistake." });
  if (!c.name && p && p.name) { await db.setCustomerName(c.id, p.name); c.name = p.name; }
  await setProfile(dev, { name: c.name || (p && p.name) || "", customer: c.id });
  await db.moveDevice(dev, "c" + c.id);
  setUserCookie(req, res, c.id);
  res.json({ ok: true, user: { name: c.name, phone: "•••-•••-" + phone.slice(-4) }, isNew: !c.name });
}));
app.post("/api/auth/name", wrap(async (req, res) => {
  const u = currentUser(req); if (!u) return res.status(401).json({ error: "Sign in first." });
  const n = clean(req.body.name, 30); if (!n) return res.status(400).json({ error: "Enter your name or stage name." });
  await db.setCustomerName(u, n);
  const dev = device(req, res), p = await getProfile(dev); if (!p || !p.name) await setProfile(dev, { name: n, customer: u });
  res.json({ ok: true });
}));
app.post("/api/auth/logout", (req, res) => { res.append("Set-Cookie", "dive_user=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly"); res.json({ ok: true }); });

/* ---------- KJ API (PIN protected) ---------- */
// hosts: the owner PIN (KJ_PIN) can add hosts, each with their own name + PIN
async function getHosts() { try { return JSON.parse((await db.getSetting("hosts")) || "[]"); } catch (e) { return []; } }
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
async function whoIs(pin) {
  if (!pin) return null;
  if (T() === "dive" ? same(pin, KJ_PIN) : pinMatches(pin, TEN().pinHash)) return { name: "Owner", admin: true };
  const h = (await getHosts()).find(x => same(pin, x.pin));
  return h ? { name: h.name, admin: false } : null;
}
const pinTries = new Map();
async function kjAuth(req, res, next) {
  try {
    const t = Date.now(), l = (pinTries.get(req.ip) || []).filter(x => t - x < 600000);
    if (l.length >= 20) return res.status(429).json({ error: "Too many wrong PINs. Wait 10 minutes." });
    const who = await whoIs(String(req.headers["x-kj-pin"] || ""));
    if (!who) { l.push(t); pinTries.set(req.ip, l); return res.status(401).json({ error: "Wrong PIN." }); }
    req.kj = who; next();
  } catch (e) { console.error(e); res.status(500).json({ error: "Something went wrong. Try again." }); }
}
app.use("/api/kj", kjAuth);
/* ---------- daily ads / promos ---------- */
async function getPromos() { try { return JSON.parse((await db.getSetting("promos")) || "[]"); } catch (e) { return []; } }
// the bar's "day" runs 6 AM to 6 AM, McAllen time
function barDay() {
  const t = new Date(Date.now() - 6 * 3600 * 1000);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: ZONE(), year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(t).map(x => [x.type, x.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday) };
}
const promoLive = (p, d) => p.on && (!p.days || !p.days.length || p.days.includes(d.dow)) && (!p.start || p.start <= d.date) && (!p.end || p.end >= d.date);
app.get("/api/promos", wrap(async (req, res) => {
  const d = barDay();
  res.json({ items: (await getPromos()).filter(p => promoLive(p, d)).map(({ id, title, text, img }) => ({ id, title, text, img })) });
}));
app.get("/api/kj/promos", wrap(async (req, res) => { const d = barDay(); res.json({ items: (await getPromos()).map(p => ({ ...p, live: promoLive(p, d) })), today: d }); }));
app.post("/api/kj/promos", wrap(async (req, res) => {
  const b = req.body || {}, clean = v => String(v || "").trim();
  const title = clean(b.title).slice(0, 60), text = clean(b.text).slice(0, 240);
  if (!title) return res.status(400).json({ error: "Add a headline." });
  let img = clean(b.img); if (img && (!/^data:image\/(jpeg|png|webp);base64,/.test(img) || img.length > 700000)) return res.status(400).json({ error: "That picture didn't work. Try another." });
  const day = v => /^\d{4}-\d{2}-\d{2}$/.test(v || "") ? v : "";
  const days = Array.isArray(b.days) ? [...new Set(b.days.map(Number).filter(n => n >= 0 && n <= 6))].sort() : [];
  const list = await getPromos();
  const item = { id: b.id && list.some(p => p.id === b.id) ? b.id : crypto.randomBytes(6).toString("hex"), title, text, img, days, start: day(b.start), end: day(b.end), on: b.on !== false };
  const i = list.findIndex(p => p.id === item.id);
  if (i >= 0) list[i] = item; else { if (list.length >= 30) return res.status(400).json({ error: "You have 30 ads. Delete an old one first." }); list.unshift(item); }
  await db.setSetting("promos", JSON.stringify(list)); res.json({ ok: true, item });
}));
app.post("/api/kj/promos/remove", wrap(async (req, res) => {
  const list = (await getPromos()).filter(p => p.id !== String((req.body || {}).id));
  await db.setSetting("promos", JSON.stringify(list)); res.json({ ok: true });
}));
app.get("/api/kj/state", wrap(async (req, res) => {
  res.json({ me: req.kj, multi: (await db.getSetting("multi")) === "on", open: (await db.getSetting("open")) !== "no", geofence: geofenceActive(await db.getSetting("geofence")), hasSpot: TEN().lat != null && TEN().lat !== "", tenant: tenantPublic(TEN()), plan: planSummary(TEN()), hostLimit: TEN().house ? null : HOST_LIMIT, pause: await pauseState(), phoneSignin: await authOn(), twilioReady: TW_READY, queue: (await db.active()).map(kjRow), done: (await db.done(50)).map(kjRow) });
}));
// everything we know about the singer on this row: past songs, nights, ratings, posts
app.get("/api/kj/singer/:id", wrap(async (req, res) => {
  const r = await db.get(parseInt(req.params.id, 10)); if (!r) return res.status(404).json({ error: "Not found." });
  const past = (await db.mineAll(r.device, "new")).filter(x => x.id !== r.id);
  const nightOf = t => new Date(new Date(t).getTime() - 6 * 3600e3).toLocaleDateString("en-CA", { timeZone: ZONE() });
  const tonight = nightOf(Date.now());
  const nights = new Set(past.map(x => nightOf(x.done_at))), before = past.filter(x => nightOf(x.done_at) !== tonight);
  const rated = past.filter(x => x.rating), counts = {};
  past.forEach(x => { const k = x.song + "|" + (x.artist || ""); counts[k] = (counts[k] || 0) + 1; });
  const fav = Object.entries(counts).sort((a, b) => b[1] - a[1]).filter(e => e[1] > 1).slice(0, 3).map(([k, n]) => { const i = k.lastIndexOf("|"); return { song: k.slice(0, i), artist: k.slice(i + 1), times: n }; });
  res.json({
    name: r.name, songs: past.length, nights: nights.size, tonight: past.length - before.length,
    firstVisit: past.length ? past[past.length - 1].done_at : null, lastVisit: before.length ? before[0].done_at : null,
    avg: rated.length ? Math.round(rated.reduce((a, x) => a + x.rating, 0) / rated.length * 10) / 10 : null,
    posts: past.filter(x => postedList(x).length).length, onWall: past.filter(x => x.public).length,
    fav, recent: past.slice(0, 8).map(histRow)
  });
}));
app.get("/api/kj/history", wrap(async (req, res) => {
  res.json({ items: (await db.history({ sort: req.query.sort === "top" ? "top" : "new", q: clean(req.query.q, 40), limit: 500 })).map(histRow) });
}));

// analytics for the KJ: everything is grouped by "karaoke night" (a night runs until 6 AM, McAllen time)
// each bar keeps its own time zone (The Dive: Central)
const ZONE = () => TEN().tz || "America/Chicago";
function nightOf(d) { return new Date(new Date(d).getTime() - 6 * 3600e3).toLocaleDateString("en-CA", { timeZone: ZONE() }); }
function hourOf(d) { return parseInt(new Date(d).toLocaleString("en-US", { timeZone: ZONE(), hour: "numeric", hour12: false }), 10) % 24; }
app.get("/api/kj/stats", wrap(async (req, res) => {
  const days = { "7": 7, "30": 30, "90": 90 }[req.query.range] || 0;
  const rows = await db.sungSince(days ? Date.now() - days * 864e5 : 0);
  const nights = new Map(), hours = new Array(24).fill(0), stars = [0, 0, 0, 0, 0], singers = new Map(), songs = new Map(), artists = new Map();
  let rated = 0, starSum = 0, onWall = 0;
  for (const r of rows) {
    const n = nightOf(r.done_at); nights.set(n, (nights.get(n) || 0) + 1);
    hours[hourOf(r.done_at)]++;
    if (r.rating) { rated++; starSum += r.rating; stars[r.rating - 1]++; }
    if (r.public) onWall++;
    const who = singers.get(r.device) || { name: r.name, songs: 0, stars: 0, rated: 0, nights: new Set(), last: r.done_at };
    who.name = r.name; who.songs++; who.nights.add(n); who.last = r.done_at; if (r.rating) { who.stars += r.rating; who.rated++; }
    singers.set(r.device, who);
    const sk = r.song.toLowerCase() + "|" + (r.artist || "").toLowerCase();
    const so = songs.get(sk) || { song: r.song, artist: r.artist, count: 0 }; so.count++; songs.set(sk, so);
    if (r.artist) { const ak = r.artist.toLowerCase(); const ar = artists.get(ak) || { artist: r.artist, count: 0 }; ar.count++; artists.set(ak, ar); }
  }
  const singerList = [...singers.values()].map(x => ({ name: x.name, songs: x.songs, nights: x.nights.size, avg: x.rated ? Math.round(x.stars / x.rated * 10) / 10 : null, last: x.last }));
  const nightList = [...nights.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-30).map(([night, count]) => ({ night, count }));
  res.json({
    range: days || "all",
    totals: { songs: rows.length, singers: singers.size, nights: nights.size, repeat: singerList.filter(x => x.nights > 1).length,
              avgRating: rated ? Math.round(starSum / rated * 10) / 10 : null, rated, onWall, perNight: nights.size ? Math.round(rows.length / nights.size * 10) / 10 : 0 },
    nights: nightList, hours, stars,
    topSingers: singerList.sort((a, b) => b.songs - a.songs || b.nights - a.nights).slice(0, 15),
    topRated: singerList.filter(x => x.avg !== null && x.songs >= 2).sort((a, b) => b.avg - a.avg || b.songs - a.songs).slice(0, 10),
    topSongs: [...songs.values()].sort((a, b) => b.count - a.count).slice(0, 15),
    topArtists: [...artists.values()].sort((a, b) => b.count - a.count).slice(0, 10)
  });
}));
const ownerOnly = (req, res, next) => req.kj && req.kj.admin ? next() : res.status(403).json({ error: "Only the owner can manage hosts." });
app.get("/api/kj/hosts", ownerOnly, wrap(async (req, res) => { res.json({ hosts: (await getHosts()).map(h => ({ name: h.name, pin: "••" + h.pin.slice(-2) })) }); }));
app.post("/api/kj/hosts", ownerOnly, wrap(async (req, res) => {
  const name = clean(req.body.name, 30), pin = String(req.body.pin || "").replace(/\D/g, "");
  if (!name) return res.status(400).json({ error: "Enter the host's name." });
  if (pin.length < 4 || pin.length > 8) return res.status(400).json({ error: "PIN must be 4 to 8 digits." });
  const hosts = await getHosts();
  if ((await whoIs(pin)) || hosts.some(h => h.pin === pin)) return res.status(409).json({ error: "That PIN is already used. Pick another." });
  if (T() !== "dive" && hosts.length >= HOST_LIMIT) return res.status(403).json({ error: "Your plan includes " + HOST_LIMIT + " host logins. Remove one to add another." });
  if (hosts.some(h => h.name.toLowerCase() === name.toLowerCase())) return res.status(409).json({ error: "There's already a host with that name." });
  hosts.push({ name, pin }); await db.setSetting("hosts", JSON.stringify(hosts)); res.json({ ok: true });
}));
app.post("/api/kj/my-pin", wrap(async (req, res) => {
  if (req.kj.admin) return res.status(400).json({ error: T() === "dive" ? "The owner PIN is changed in Render (KJ_PIN)." : "Change the owner PIN on the Setup page." });
  const pin = String(req.body.pin || "").replace(/\D/g, ""), hosts = await getHosts();
  if (pin.length < 4 || pin.length > 8) return res.status(400).json({ error: "PIN must be 4 to 8 digits." });
  const taken = await whoIs(pin);
  if ((taken && taken.admin) || hosts.some(h => h.pin === pin && h.name !== req.kj.name)) return res.status(409).json({ error: "That PIN is taken. Pick another." });
  const me = hosts.find(h => h.name === req.kj.name); if (!me) return res.status(404).json({ error: "Host not found." });
  me.pin = pin; await db.setSetting("hosts", JSON.stringify(hosts)); res.json({ ok: true });
}));
app.post("/api/kj/hosts/remove", ownerOnly, wrap(async (req, res) => {
  const name = String(req.body.name || ""), hosts = (await getHosts()).filter(h => h.name !== name);
  await db.setSetting("hosts", JSON.stringify(hosts)); res.json({ ok: true });
}));
app.post("/api/kj/next", wrap(async (req, res) => {
  const list = await db.active();
  const up = list.find(r => r.status === "up"); if (up) await db.setStatus(up.id, "done");
  const nxt = list.find(r => r.status === "queued"); if (nxt) await db.setStatus(nxt.id, "up");
  res.json({ ok: true });
}));
app.post("/api/kj/:id/rename", wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10), row = await db.get(id), n = clean(req.body.name, 30);
  if (!row) return res.status(404).json({ error: "That singer isn't on the list anymore." });
  if (!n) return res.status(400).json({ error: "Enter a name." });
  await db.rename(id, n);
  if (row.device.startsWith("c")) await db.setCustomerName(parseInt(row.device.slice(1), 10), n);
  else { const p = await getProfile(row.device); await setProfile(row.device, { ...(p || {}), name: n }); }
  res.json({ ok: true });
}));
app.post("/api/kj/:id/:action", wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10), action = req.params.action, row = await db.get(id);
  if (!row) return res.status(404).json({ error: "That singer isn't on the list anymore." });
  if (action === "remove") await db.setStatus(id, "removed");
  else if (action === "done") await db.setStatus(id, "done");
  else if (action === "up") {
    const list = await db.active(), cur = list.find(r => r.status === "up");
    if (cur && cur.id !== id) await db.setStatus(cur.id, "queued");
    await db.setStatus(id, "up");
  } else if (action === "raise" || action === "lower") {
    const q = (await db.active()).filter(r => r.status === "queued"), i = q.findIndex(r => r.id === id);
    const j = action === "raise" ? i - 1 : i + 1;
    if (i > -1 && j >= 0 && j < q.length) { await db.setPos(q[i].id, q[j].position); await db.setPos(q[j].id, q[i].position); }
  } else return res.status(400).json({ error: "Unknown action." });
  res.json({ ok: true });
}));
app.post("/api/kj-open", kjAuth, wrap(async (req, res) => {
  await db.setSetting("open", req.body.open ? "yes" : "no"); res.json({ ok: true });
}));
app.post("/api/kj-multi", kjAuth, wrap(async (req, res) => {
  await db.setSetting("multi", req.body.on ? "on" : "off"); res.json({ ok: true });
}));
app.post("/api/kj-geofence", kjAuth, wrap(async (req, res) => {
  await db.setSetting("geofence", req.body.on ? "on" : "off"); res.json({ ok: true });
}));
app.post("/api/kj-phone", kjAuth, wrap(async (req, res) => {
  await db.setSetting("phone_signin", req.body.on ? "on" : "off"); res.json({ ok: true });
}));
app.post("/api/kj-pause", kjAuth, wrap(async (req, res) => {
  const m = Number(req.body.minutes);
  await db.setSetting("paused", m === 0 ? "off" : m > 0 ? String(Date.now() + Math.min(m, 240) * 60000) : "on");
  res.json({ ok: true });
}));
app.post("/api/kj-newnight", kjAuth, wrap(async (req, res) => {
  await db.newNight(); res.json({ ok: true });
}));

/* ---------- QR code ---------- */
app.get("/qr.svg", wrap(async (req, res) => {
  const svg = await QRCode.toString(siteUrl(req) + BASE() + "/?at=" + TEN().qr, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#0a0c0a", light: "#ffffff" } });
  res.type("image/svg+xml").set("Cache-Control", "public, max-age=3600").send(svg);
}));
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
app.get("/s/:id", wrap(async (req, res) => {
  const r = await db.get(parseInt(req.params.id, 10)), base = siteUrl(req) + BASE();
  if (!r || !r.public) return res.redirect(BASE() + "/wall");
  const stars = r.rating ? "★".repeat(r.rating) + "☆".repeat(5 - r.rating) : "";
  const title = `${r.name} sang ${r.song} at The Dive on 495`;
  res.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc((stars ? stars + " · " : "") + "Karaoke night at The Dive on 495, McAllen, TX. Scan to sing!")}">
<meta property="og:image" content="${esc(base)}/logo.png"><meta property="og:url" content="${esc(base)}/s/${r.id}"><meta property="og:type" content="website">
<link rel="icon" href="/logo.png"><style>body{margin:0;background:#0a0c0a;color:#eef3ee;font-family:system-ui,-apple-system,sans-serif;display:grid;place-items:center;min-height:100vh;padding:24px;box-sizing:border-box;text-align:center}
img{width:160px;filter:drop-shadow(0 0 20px rgba(57,181,74,.55))}h1{font-family:Georgia,serif;font-size:28px;margin:16px 0 4px}.s{color:#5fd36e;font-size:30px;letter-spacing:4px}p{color:#9fae9f}a{display:inline-block;margin-top:14px;background:#39b54a;color:#041206;font-weight:700;text-decoration:none;padding:12px 22px;border-radius:999px}</style></head>
<body><main><img src="/logo.png" alt="The Dive on 495"><h1>${esc(r.name)}</h1><div>sang <b>${esc(r.song)}</b>${r.artist ? " – " + esc(r.artist) : ""}</div><div class="s">${stars}</div>
<p>Karaoke at The Dive on 495 · McAllen, TX</p><a href="/wall">See the wall of fame</a></main></body></html>`.replace(/<html[\s\S]*$/, h => brand(h, TEN(), BASE())));
}));
app.get("/api/url", (req, res) => res.json({ url: siteUrl(req) + BASE() + "/" }));

/* ---------- new bar / DJ sign-up (main site only: /start) ---------- */
const startHits = new Map();
function cleanTenantFields(b, t) {
  if (b.name !== undefined) { const n = cleanName(b.name, 50); if (n) t.name = n; }
  if (b.short !== undefined) t.short = cleanName(b.short, 24) || t.name;
  if (b.city !== undefined) t.city = cleanName(b.city, 40);
  if (b.address !== undefined) t.address = cleanName(b.address, 100);
  if (b.email !== undefined) t.email = clean(b.email, 120).toLowerCase();
  if (b.lat !== undefined && b.lng !== undefined) {
    const lat = Number(b.lat), lng = Number(b.lng);
    if (b.lat === "" || b.lat === null) { t.lat = null; t.lng = null; }
    else if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) { t.lat = lat; t.lng = lng; }
  }
  if (b.radius !== undefined) t.radius = Math.min(1000, Math.max(50, Number(b.radius) || 150));
  if (b.venue !== undefined) t.venue = cleanName(b.venue, 60);
  if (b.tz !== undefined) { try { new Intl.DateTimeFormat("en-US", { timeZone: String(b.tz) }); t.tz = String(b.tz).slice(0, 60); } catch (e) { return "Pick a time zone from the list."; } }
  if (b.tags) t.tags = Object.fromEntries(["Facebook", "Instagram", "TikTok"].map(k => [k, cleanName(b.tags[k] || "", 60)]).filter(([, v]) => v));
  if (b.logo !== undefined) {
    if (!b.logo) t.logo = "";
    else if (/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(b.logo) && b.logo.length < 600000) t.logo = b.logo;
    else return "That logo didn't work. Try a PNG or JPG under 400 KB.";
  }
  return null;
}
app.get("/api/start/check", wrap(async (req, res) => {
  const slug = slugify(req.query.slug);
  if (slug.length < 3) return res.json({ ok: false, slug, error: "Use at least 3 letters or numbers." });
  if (RESERVED.has(slug) || await db.getTenant(slug)) return res.json({ ok: false, slug, error: "That web name is taken. Try another." });
  res.json({ ok: true, slug });
}));
app.post("/api/start", wrap(async (req, res) => {
  if (!TEN().house) return res.status(400).json({ error: "Start from the main sign-up page." });
  const ip = req.ip, now = Date.now(), l = (startHits.get(ip) || []).filter(x => now - x < 3600e3);
  if (l.length >= 5) return res.status(429).json({ error: "Too many sign-ups from here. Try again in an hour." });
  const b = req.body || {};
  const type = b.type === "dj" ? "dj" : "bar";
  const name = cleanName(b.name, 50); if (!name) return res.status(400).json({ error: type === "dj" ? "Enter your DJ business name." : "Enter the bar's name." });
  const slug = slugify(b.slug || name);
  if (slug.length < 3) return res.status(400).json({ error: "Pick a web name with at least 3 letters or numbers." });
  if (RESERVED.has(slug) || await db.getTenant(slug)) return res.status(409).json({ error: "That web name is taken. Try another." });
  const email = clean(b.email, 120).toLowerCase(); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "Enter a good email address." });
  const pin = String(b.pin || "").replace(/\D/g, ""); if (pin.length < 4 || pin.length > 8) return res.status(400).json({ error: "Pick an owner PIN of 4 to 8 digits." });
  if (b.agree !== true) return res.status(400).json({ error: "Check the box to agree to the service terms." });
  const t = { slug, type, name, short: name, pinHash: hashPin(pin), qr: crypto.randomBytes(4).toString("hex"), radius: 150, plan: null, created: new Date().toISOString(), agreedAt: new Date().toISOString(), agreedIp: ip };
  const err = cleanTenantFields({ ...b, name: undefined, short: b.short || name }, t); if (err) return res.status(400).json({ error: err });
  l.push(now); startHits.set(ip, l);
  // plan: a code from Stemo, otherwise the 14-day free trial
  let note = "";
  const code = clean(b.code, 40).toUpperCase();
  if (code) {
    const j = await myApps("/api/v1/redeem-tenant", { tenant: tkey(slug), tenantName: name, code });
    if (!j) return res.status(503).json({ error: "We couldn't check the code right now. Try again, or leave the code blank to start the free trial." });
    if (!j.ok) return res.status(400).json({ error: j.error || "That code didn't work." });
    t.plan = { plan: "pro", expires_on: j.expires_on ? String(j.expires_on).slice(0, 10) : null, source: "code" }; note = "Code applied: " + j.days + " days.";
  } else {
    const j = await myApps("/api/v1/trial", { tenant: tkey(slug), tenantName: name, days: TRIAL_DAYS });
    t.plan = j && j.ok && j.plan === "pro" ? { plan: "pro", expires_on: String(j.expires_on).slice(0, 10), source: j.source || "trial" } : { plan: "pro", expires_on: addDays(TRIAL_DAYS), source: "trial" };
    note = "Your " + TRIAL_DAYS + "-day free trial has started.";
  }
  await saveTenant(t);
  console.log(`New ${type}: ${name} (/b/${slug})`);
  res.json({ ok: true, slug, base: "/b/" + slug, note, plan: planSummary(t) });
}));

/* ---------- bar / DJ owner settings (/b/<slug>/setup) ---------- */
async function ownerAuth(req, res) {
  const t = TEN(); if (t.house) { res.status(400).json({ error: "The Dive is set up in Render." }); return null; }
  const ip = req.ip, now = Date.now(), l = (pinTries.get(ip) || []).filter(x => now - x < 600000);
  if (l.length >= 20) { res.status(429).json({ error: "Too many wrong PINs. Wait 10 minutes." }); return null; }
  const fresh = await db.getTenant(t.slug);
  if (!fresh || !pinMatches(String(req.headers["x-kj-pin"] || ""), fresh.pinHash)) { l.push(now); pinTries.set(ip, l); res.status(401).json({ error: "Wrong owner PIN." }); return null; }
  return fresh;
}
const ownerView = (t, req) => ({ slug: t.slug, type: t.type || "bar", name: t.name, short: t.short, city: t.city || "", address: t.address || "", email: t.email || "",
  lat: t.lat ?? null, lng: t.lng ?? null, radius: t.radius || 150, tz: t.tz || "America/Chicago", venue: t.venue || "", tags: t.tags || {}, logo: t.logo || "", hasLogo: !!t.logo,
  plan: planSummary(t), price: PRICE_TEXT, cardReady: !!(STRIPE.key && STRIPE.price), paid: !!(t.stripe && t.stripe.customer), hostLimit: HOST_LIMIT,
  links: { app: siteUrl(req) + BASE() + "/", kj: siteUrl(req) + BASE() + "/kj", tv: siteUrl(req) + BASE() + "/tv", poster: siteUrl(req) + BASE() + "/poster", staff: siteUrl(req) + BASE() + "/staff" } });
app.post("/api/setup/me", wrap(async (req, res) => { const t = await ownerAuth(req, res); if (t) res.json(ownerView(t, req)); }));
app.post("/api/setup/save", wrap(async (req, res) => {
  const t = await ownerAuth(req, res); if (!t) return;
  const b = req.body || {};
  const err = cleanTenantFields(b, t); if (err) return res.status(400).json({ error: err });
  if (b.newPin) { const p = String(b.newPin).replace(/\D/g, ""); if (p.length < 4 || p.length > 8) return res.status(400).json({ error: "New PIN must be 4 to 8 digits." }); t.pinHash = hashPin(p); }
  await saveTenant(t); res.json({ ok: true, ...ownerView(t, req) });
}));
app.post("/api/setup/code", wrap(async (req, res) => {
  const t = await ownerAuth(req, res); if (!t) return;
  const code = clean((req.body || {}).code, 40).toUpperCase(); if (!code) return res.status(400).json({ error: "Enter the code." });
  const j = await myApps("/api/v1/redeem-tenant", { tenant: tkey(t.slug), tenantName: t.name, code });
  if (!j) return res.status(503).json({ error: "We couldn't check the code right now. Try again in a minute." });
  if (!j.ok) return res.status(400).json({ error: j.error || "That code didn't work." });
  t.plan = { plan: "pro", expires_on: j.expires_on ? String(j.expires_on).slice(0, 10) : null, source: "code" }; await saveTenant(t);
  res.json({ ok: true, message: "Code applied: " + j.days + " days added.", ...ownerView(t, req) });
}));
app.post("/api/billing/checkout", wrap(async (req, res) => {
  const t = await ownerAuth(req, res); if (!t) return;
  if (!STRIPE.key || !STRIPE.price) return res.status(400).json({ error: "Card payments aren't turned on yet. Ask Stemo Enterprises for a code." });
  const back = siteUrl(req) + BASE() + "/setup";
  const form = { mode: "subscription", "line_items[0][price]": STRIPE.price, "line_items[0][quantity]": "1", success_url: back + "?paid=1", cancel_url: back,
    client_reference_id: t.slug, "metadata[tenant]": t.slug, "subscription_data[metadata][tenant]": t.slug, allow_promotion_codes: "true" };
  if (t.stripe && t.stripe.customer) form.customer = t.stripe.customer; else if (t.email) form.customer_email = t.email;
  try { const s = await stripeApi("checkout/sessions", form); res.json({ url: s.url }); }
  catch (e) { console.error("checkout:", e.message); res.status(502).json({ error: "Card checkout isn't working right now: " + e.message }); }
}));
app.post("/api/billing/portal", wrap(async (req, res) => {
  const t = await ownerAuth(req, res); if (!t) return;
  if (!STRIPE.key || !(t.stripe && t.stripe.customer)) return res.status(400).json({ error: "There's no card subscription to manage yet." });
  try { const s = await stripeApi("billing_portal/sessions", { customer: t.stripe.customer, return_url: siteUrl(req) + BASE() + "/setup" }); res.json({ url: s.url }); }
  catch (e) { res.status(502).json({ error: "Billing page isn't working right now: " + e.message }); }
}));

/* ---------- for My Apps (the manager office): list and manage bars ---------- */
function platformAuth(req, res) {
  const k = String(req.headers["x-platform-key"] || "");
  if (!PLATFORM_KEY || k.length !== PLATFORM_KEY.length || !crypto.timingSafeEqual(Buffer.from(k), Buffer.from(PLATFORM_KEY))) { res.status(401).json({ error: "Wrong platform key." }); return false; }
  return true;
}
app.get("/api/platform/bars", wrap(async (req, res) => {
  if (!platformAuth(req, res)) return;
  const [list, counts] = [await db.listTenants(), await db.tenantCounts()];
  const out = [];
  for (const t of list) {
    const hosts = await ctx.run({ t: t.slug, tenant: t, base: "/b/" + t.slug }, () => getHosts());
    out.push({ slug: t.slug, key: tkey(t.slug), type: t.type || "bar", name: t.name, city: t.city || "", email: t.email || "", created: t.created || t.created_at,
      hosts: hosts.length, songs: (counts[t.slug] || {}).songs || 0, lastSong: (counts[t.slug] || {}).last || null, plan: planSummary(t), disabled: !!t.disabled,
      url: siteUrl(req) + "/b/" + t.slug + "/", kj: siteUrl(req) + "/b/" + t.slug + "/kj" });
  }
  res.json({ bars: out, house: { name: DIVE.name, songs: (counts.dive || {}).songs || 0 } });
}));
app.post("/api/platform/bars/:slug", wrap(async (req, res) => {
  if (!platformAuth(req, res)) return;
  const t = await db.getTenant(req.params.slug); if (!t) return res.status(404).json({ error: "No such bar." });
  const b = req.body || {};
  if (b.action === "disable") t.disabled = true;
  else if (b.action === "enable") t.disabled = false;
  else if (b.action === "pin") { const p = String(b.pin || "").replace(/\D/g, ""); if (p.length < 4 || p.length > 8) return res.status(400).json({ error: "PIN must be 4 to 8 digits." }); t.pinHash = hashPin(p); }
  else if (b.action === "plan") { t.plan = { plan: b.plan === "pro" ? "pro" : "free", expires_on: b.expires_on ? String(b.expires_on).slice(0, 10) : null, source: b.source || "manual" }; }
  else return res.status(400).json({ error: "Unknown action." });
  await saveTenant(t); planChecked.delete(t.slug); res.json({ ok: true, plan: planSummary(t) });
}));

/* ---------- DJs (and bars): "I'm at a new venue tonight" ---------- */
app.post("/api/kj/venue", wrap(async (req, res) => {
  const cur = TEN(); if (cur.house) return res.status(400).json({ error: "The Dive's location is set in Render." });
  const t = await db.getTenant(cur.slug), b = req.body || {};
  const err = cleanTenantFields({ venue: b.venue, lat: b.lat, lng: b.lng }, t); if (err) return res.status(400).json({ error: err });
  await saveTenant(t); res.json({ ok: true, venue: t.venue, hasSpot: t.lat != null });
}));

/* ---------- pages ---------- */
// HTML pages: sent as-is for The Dive, re-branded for other bars and DJs
const PAGES = { "/": "index.html", "/kj": "kj.html", "/poster": "poster.html", "/tent": "tent.html", "/terms": "terms.html", "/staff": "staff.html", "/setup": "setup.html", "/start": "start.html" };
// extra pages that each install as their own app (own name + icon)
const APPS = {
  "/stats": { file: "stats.html", key: "stats", name: "The Dive Analytics", short: "Dive Stats" },
  "/ads": { file: "ads.html", key: "ads", name: "The Dive Ads", short: "Dive Ads" },
  "/wheel": { file: "wheel.html", key: "wheel", name: "The Dive Spin Wheel", short: "Dive Wheel" },
  "/tv": { file: "tv.html", key: "tv", name: "The Dive TV Screen", short: "Dive TV" },
  "/history": { file: "history.html", key: "history", name: "The Dive Customer History", short: "Dive History" },
  "/wall": { file: "wall.html", key: "wall", name: "The Dive Wall of Fame", short: "Dive Fame" }
};
Object.entries(APPS).forEach(([route, a]) => {
  app.get("/m/" + a.key + ".json", (req, res) => {
    const t = TEN(), B = BASE(), j = { id: B + route, name: a.name, short_name: a.short, start_url: B + route, scope: B + route, display: "standalone",
      background_color: "#0a0c0a", theme_color: "#0a0c0a",
      icons: [{ src: B + "/" + a.key + "-icon-192.png", sizes: "192x192", type: "image/png" }, { src: B + "/" + a.key + "-icon-512.png", sizes: "512x512", type: "image/png" }] };
    if (!t.house) { j.name = a.name.replace("The Dive", t.short); j.short_name = a.short.replace("Dive", t.short); j.icons.forEach(i => { i.sizes = "any"; }); }
    res.type("application/manifest+json").json(j);
  });
  ["-icon-192.png", "-icon-512.png", "-apple-touch-icon.png"].forEach(sfx => app.get("/" + a.key + sfx, (req, res) => sendLogo(req, res, a.key + sfx)));
  app.get(route, (req, res) => sendPage(req, res, a.file, a));
});
Object.entries(PAGES).forEach(([route, file]) => app.get(route, (req, res) => {
  if (route === "/start" && !TEN().house) return res.redirect("/start");          // sign-up is only on the main site
  if (route === "/setup" && TEN().house) return res.redirect("/kj");             // The Dive is set up in Render
  sendPage(req, res, file);
}));
// manifests + service worker carry paths, so they're re-branded too
["/manifest.json", "/kj-manifest.json", "/staff-manifest.json"].forEach(r => app.get(r, (req, res) => {
  if (TEN().house) return res.sendFile(path.join(__dirname, r.slice(1)));
  const t = TEN(); let j = JSON.parse(brand(fs.readFileSync(path.join(__dirname, r.slice(1)), "utf8"), t, BASE(), req.get("host")));
  (j.icons || []).forEach(i => { i.sizes = "any"; delete i.purpose; });
  res.type("application/manifest+json").json(j);
}));
app.get("/sw.js", (req, res) => sendPage(req, res, "sw.js", null, "application/javascript"));
app.get("/zoom.js", (req, res) => res.type("application/javascript").sendFile(path.join(__dirname, "zoom.js")));
app.get("/install.js", (req, res) => res.type("application/javascript").sendFile(path.join(__dirname, "install.js")));
app.get("/default-logo.png", (req, res) => res.sendFile(path.join(__dirname, "default-logo.png")));
app.get("/songs.json", (req, res) => res.sendFile(path.join(__dirname, "songs.json")));
["/logo.png", "/icon-192.png", "/icon-512.png", "/icon-maskable.png", "/apple-touch-icon.png", "/kj-icon-192.png", "/kj-icon-512.png", "/kj-apple-touch-icon.png",
 "/staff-icon-192.png", "/staff-icon-512.png", "/staff-apple-touch-icon.png"].forEach(r => app.get(r, (req, res) => sendLogo(req, res, r.slice(1))));
app.get("/healthz", (req, res) => res.send("ok"));

db.init().then(async () => {
  if (!SESSION_SECRET) { SESSION_SECRET = await db.getSetting("session_secret"); if (!SESSION_SECRET) { SESSION_SECRET = crypto.randomBytes(32).toString("hex"); await db.setSetting("session_secret", SESSION_SECRET); } }
  await setupTwilio();
  console.log(TW_READY ? "Twilio ready. Phone sign-in switch: " + ((await db.getSetting("phone_signin")) || process.env.PHONE_SIGNIN || "on") : "Phone sign-in: off (set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN)");
}).then(() => app.listen(PORT, () => console.log(`Dive sign-up running on port ${PORT}`)));
