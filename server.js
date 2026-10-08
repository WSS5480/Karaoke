const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const QRCode = require("qrcode");
const webpush = require("web-push");
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
  if (/^\/(kj|stats|ads|history|staff|owner|links|watch|bar|wheel|tv|tent|poster)\b/.test(req.path)) return res.redirect(BASE() + "/setup");
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
// singers must always be at the bar to sign up: the location check can't be turned off (only works once the bar's spot is set)
function geofenceActive() { const t = TEN(); return t.lat != null && t.lat !== "" && Number.isFinite(Number(t.lat)); }

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
const PATH_RE = /(["'`(])\/(?=(?:api\/|kj\b|wall\b|tv\b|tent\b|poster\b|history\b|stats\b|ads\b|terms\b|staff\b|owner\b|links\/|watch\b|bar\b|wheel\b|setup\b|s\/|m\/|qr\.svg|logo\.png|songs\.json|sw\.js|install\.js|zoom\.js|update\.js|forgot\.js|[\w-]*manifest\.json|[\w-]*icon[\w-]*\.png|[\w-]*apple-touch-icon\.png|\?|["'`)]))/g;
function brand(html, t, base, host) {
  if (t.house) return html;
  const name = t.name, short = t.short || t.name, tagWord = (short || name).replace(/[^A-Za-z0-9]/g, ""), city = t.city || "";
  const tags = Object.assign({ Facebook: "@" + name, Instagram: "@" + tagWord.toLowerCase(), TikTok: "@" + tagWord.toLowerCase() }, t.tags || {});
  let h = html.replace(PATH_RE, (m, q) => q + base + "/");
  h = h.replace(/const LOGO_SRC = "[^"]*"/, `const LOGO_SRC = "${base}/logo.png"`)
       .replace(/(<div class="qrcorner"[^>]*>)<svg[\s\S]*?<\/svg>/, `$1<img src="${base}/qr.svg" alt="QR code to sign up" style="display:block;width:100%">`)
       .replace(/const DIVE_TAGS = \{[^}]*\};/, "const DIVE_TAGS = " + JSON.stringify(tags) + ";")
       .replace(/const DIVE_FOLLOW = \{[^}]*\};/, "const DIVE_FOLLOW = {};")
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
  // every page keeps its installed app up to date by itself
  if (file.endsWith(".html") && !html.includes("/update.js")) html = html.replace("</head>", '<script src="/update.js" defer></script>\n</head>');
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
app.use("/api/photo", express.json({ limit: "400kb" })); // singer photos
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
  // a dropped idle database connection must not take the whole app down; the pool reconnects on the next query
  pool.on("error", e => console.error("db idle connection dropped:", e.message));
  const Q = (sql, args) => pool.query(sql, args);
  db = {
    async init() {
      await Q(`CREATE TABLE IF NOT EXISTS signups (
        id SERIAL PRIMARY KEY, name TEXT NOT NULL, song TEXT NOT NULL, artist TEXT DEFAULT '',
        device TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', position DOUBLE PRECISION NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), done_at TIMESTAMPTZ)`);
      await Q(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);
      await Q(`ALTER TABLE signups ADD COLUMN IF NOT EXISTS rating INT`);
      await Q(`ALTER TABLE signups ADD COLUMN IF NOT EXISTS likes INT NOT NULL DEFAULT 0`);
      await Q(`ALTER TABLE signups ADD COLUMN IF NOT EXISTS public BOOLEAN NOT NULL DEFAULT false`);
      await Q(`ALTER TABLE signups ADD COLUMN IF NOT EXISTS posted_to TEXT NOT NULL DEFAULT ''`);
      await Q(`ALTER TABLE signups ADD COLUMN IF NOT EXISTS post_links TEXT NOT NULL DEFAULT ''`);
      await Q(`ALTER TABLE signups ADD COLUMN IF NOT EXISTS via TEXT NOT NULL DEFAULT ''`);   // how they signed up: qr, app, link, dj
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
    async mineAll(d, sort) { return (await Q(`SELECT * FROM signups WHERE tenant=$2 AND device=$1 AND done_at IS NOT NULL AND status IN ('done','archived') ORDER BY ${sort === "top" ? "likes DESC, done_at DESC" : "done_at DESC"} LIMIT 200`, [d, T()])).rows; },
    async sungSince(t) { return (await Q(`SELECT name, song, artist, device, likes, public, done_at FROM signups WHERE tenant=$2 AND done_at IS NOT NULL AND status IN ('done','archived') AND done_at >= $1 ORDER BY done_at`, [new Date(t), T()])).rows; },
    async lastSung(d) { return (await Q(`SELECT * FROM signups WHERE tenant=$2 AND device=$1 AND status IN ('done','archived') AND done_at > now() - interval '12 hours' ORDER BY done_at DESC LIMIT 1`, [d, T()])).rows[0]; },
    async setPublic(id, pub) { await Q(`UPDATE signups SET public=$2 WHERE id=$1 AND tenant=$3`, [id, pub, T()]); },
    async addLike(id, n) { const r = await Q(`UPDATE signups SET likes=GREATEST(0, likes+$2) WHERE id=$1 AND tenant=$3 RETURNING likes`, [id, n, T()]); return r.rows[0] ? r.rows[0].likes : 0; },
    async setPosted(id, v) { await Q(`UPDATE signups SET posted_to=$2 WHERE id=$1 AND tenant=$3`, [id, v, T()]); },
    async setPostLinks(id, v) { await Q(`UPDATE signups SET post_links=$2 WHERE id=$1 AND tenant=$3`, [id, v, T()]); },
    async history(o) {
      const where = [`done_at IS NOT NULL`, `tenant=$1`], args = [T()];
      if (o.onlyPublic) where.push(`public`);
      if (o.q) { args.push('%' + o.q.toLowerCase() + '%'); where.push(`(lower(name) LIKE $${args.length} OR lower(song) LIKE $${args.length} OR lower(artist) LIKE $${args.length})`); }
      args.push(o.limit);
      const order = o.sort === "top" ? `likes DESC, done_at DESC` : `done_at DESC`;
      return (await Q(`SELECT * FROM signups WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT $${args.length}`, args)).rows;
    },
    async active() { return (await Q(`SELECT * FROM signups WHERE tenant=$1 AND status IN ('up','queued') ORDER BY (status='up') DESC, position`, [T()])).rows; },
    async done(limit) { return (await Q(`SELECT * FROM signups WHERE tenant=$2 AND status='done' ORDER BY done_at DESC LIMIT $1`, [limit, T()])).rows; },
    async byDevice(d) { return (await Q(`SELECT * FROM signups WHERE tenant=$2 AND device=$1 AND status IN ('up','queued') LIMIT 1`, [d, T()])).rows[0]; },
    async add(r) { return (await Q(`INSERT INTO signups (name,song,artist,device,tenant,via,position) VALUES ($1,$2,$3,$4,$5,$6,(SELECT COALESCE(MAX(position),0)+1 FROM signups WHERE tenant=$5)) RETURNING *`, [r.name, r.song, r.artist, r.device, T(), r.via || ""])).rows[0]; },
    async setStatus(id, s) { await Q(`UPDATE signups SET status=$2, done_at=CASE WHEN $2='done' THEN now() ELSE done_at END WHERE id=$1 AND tenant=$3`, [id, s, T()]); },
    async rename(id, n) { await Q(`UPDATE signups SET name=$2 WHERE id=$1 AND tenant=$3`, [id, n, T()]); },
    async setSong(id, song, artist) { await Q(`UPDATE signups SET song=$2, artist=$3 WHERE id=$1 AND tenant=$4`, [id, song, artist, T()]); },
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
    async mineAll(d, sort) { return rows.filter(r => mine(r) && r.device === d && r.done_at && (r.status === "done" || r.status === "archived")).sort(sort === "top" ? (a, b) => (b.likes || 0) - (a.likes || 0) || b.done_at.localeCompare(a.done_at) : (a, b) => b.done_at.localeCompare(a.done_at)).slice(0, 200); },
    async sungSince(t) { return rows.filter(r => mine(r) && r.done_at && (r.status === "done" || r.status === "archived") && Date.parse(r.done_at) >= t).sort((a, b) => a.done_at.localeCompare(b.done_at)); },
    async lastSung(d) { const cut = Date.now() - 12 * 3600e3; return rows.filter(r => mine(r) && r.device === d && (r.status === "done" || r.status === "archived") && r.done_at && Date.parse(r.done_at) > cut).sort((a, b) => b.done_at.localeCompare(a.done_at))[0]; },
    async setPublic(id, pub) { const r = rows.find(x => x.id === id && mine(x)); if (r) r.public = pub; },
    async addLike(id, n) { const r = rows.find(x => x.id === id && mine(x)); if (!r) return 0; r.likes = Math.max(0, (r.likes || 0) + n); return r.likes; },
    async setPosted(id, v) { const r = rows.find(x => x.id === id && mine(x)); if (r) r.posted_to = v; },
    async setPostLinks(id, v) { const r = rows.find(x => x.id === id && mine(x)); if (r) r.post_links = v; },
    async history(o) {
      let l = rows.filter(r => mine(r) && r.done_at && (!o.onlyPublic || r.public));
      if (o.q) { const q = o.q.toLowerCase(); l = l.filter(r => (r.name + " " + r.song + " " + r.artist).toLowerCase().includes(q)); }
      l.sort(o.sort === "top" ? (a, b) => (b.likes || 0) - (a.likes || 0) || b.done_at.localeCompare(a.done_at) : (a, b) => b.done_at.localeCompare(a.done_at));
      return l.slice(0, o.limit);
    },
    async active() { return rows.filter(r => mine(r) && (r.status === "up" || r.status === "queued")).sort((a, b) => (b.status === "up") - (a.status === "up") || a.position - b.position); },
    async done(limit) { return rows.filter(r => mine(r) && r.status === "done").sort((a, b) => b.done_at.localeCompare(a.done_at)).slice(0, limit); },
    async byDevice(d) { return rows.find(r => mine(r) && r.device === d && (r.status === "up" || r.status === "queued")); },
    async add(r) { const row = { ...r, tenant: T(), id: ++seq, status: "queued", position: Math.max(0, ...rows.filter(mine).map(x => x.position)) + 1, created_at: now(), done_at: null, rating: null, public: false }; rows.push(row); return row; },
    async setStatus(id, s) { const r = rows.find(x => x.id === id && mine(x)); if (r) { r.status = s; if (s === "done") r.done_at = now(); } },
    async rename(id, n) { const r = rows.find(x => x.id === id && mine(x)); if (r) r.name = n; },
    async setSong(id, song, artist) { const r = rows.find(x => x.id === id && mine(x)); if (r) { r.song = song; r.artist = artist; } },
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
// songs the DJ doesn't have: the singer keeps their spot and is asked to pick another
async function noSongs() { try { return new Set(JSON.parse((await db.getSetting("nosong")) || "[]")); } catch (e) { return new Set(); } }
/* repeat songs: a song already sung tonight (or earlier in line) gets a yes/no for the DJ.
   "Ask to change" uses the don't-have-it flow, with its own message to the singer. */
const songKey = x => String(x || "").toLowerCase().replace(/\(.*?\)|\[.*?\]/g, " ").replace(/^the\s+/, "").replace(/[^a-z0-9]+/g, "");
async function idSet(k) { try { return new Set(JSON.parse((await db.getSetting(k)) || "[]")); } catch (e) { return new Set(); } }
async function idSetPut(k, id, on) { const s = await idSet(k); if (on) s.add(id); else s.delete(id); await db.setSetting(k, JSON.stringify([...s].slice(-300))); }
async function clearRepeat(id) { await idSetPut("repeat_ok", id, false); await idSetPut("repeat_ask", id, false); }
async function repeatsFor(list) {
  const out = new Map(), seen = new Map(), add = (r, info) => { const k = songKey(r.song); if (k.length < 2) return; (seen.get(k) || seen.set(k, []).get(k)).push({ ...info, artist: songKey(r.artist), id: r.id }); };
  let sung = []; try { sung = await db.sungSince(await nightStart()); } catch (e) {}
  sung.forEach(r => add(r, { by: r.name, at: r.done_at, where: "sung" }));
  const up = list.find(r => r.status === "up"); if (up) add(up, { by: up.name, where: "singing now" });
  const q = list.filter(r => r.status === "queued");
  q.forEach((r, i) => {
    const k = songKey(r.song), a = songKey(r.artist);
    const hit = (seen.get(k) || []).find(x => x.id !== r.id && (!a || !x.artist || a === x.artist));
    if (hit) out.set(r.id, { by: hit.by, at: hit.at || null, where: hit.where });
    add(r, { by: r.name, where: "#" + (i + 1) + " in line" });
  });
  return out;
}
async function setNoSong(id, on) { const s = await noSongs(); if (on) s.add(id); else s.delete(id); await db.setSetting("nosong", JSON.stringify([...s].slice(-300))); }
/* ---------- estimated time to sing: song lengths + tonight's DJ rhythm ----------
   Song lengths come from Apple Music's catalog (cached). Rhythm = the average time between songs tonight beyond
   the song itself (talking, changeovers, breaks under 20 min). Until there's enough data: 3:45 songs, 1.5 min between. */
const DEF_SONG = 225, DEF_GAP = 90, durCache = new Map(), durWaiting = new Set();
const durKey = (song, artist) => (String(song || "") + "|" + String(artist || "")).toLowerCase().replace(/[^a-z0-9|]+/g, " ").trim();
function songSecs(song, artist) {
  const k = durKey(song, artist); if (durCache.has(k)) return durCache.get(k);
  if (!durWaiting.has(k) && durWaiting.size < 40) {
    durWaiting.add(k);
    (async () => {
      let secs = 0;
      try {
        const r = await fetch("https://itunes.apple.com/search?media=music&entity=song&country=us&limit=5&term=" + encodeURIComponent((song + " " + (artist || "")).trim()), { signal: AbortSignal.timeout(4000) });
        if (r.ok) { const j = await r.json(), want = String(song).toLowerCase().slice(0, 12); const hit = (j.results || []).find(x => String(x.trackName || "").toLowerCase().includes(want)) || (j.results || [])[0]; if (hit && hit.trackTimeMillis) secs = Math.round(hit.trackTimeMillis / 1000); }
      } catch (e) {}
      durCache.set(k, secs >= 60 && secs <= 900 ? secs : DEF_SONG); durWaiting.delete(k);
      if (durCache.size > 5000) durCache.clear();
    })();
  }
  return DEF_SONG;
}
async function upAt() { try { return JSON.parse((await db.getSetting("up_at")) || "null"); } catch (e) { return null; } }
async function markUp(id) { await db.setSetting("up_at", JSON.stringify({ id, at: Date.now() })); }
const gapCache = new Map();
async function rhythmGap() {
  const c = gapCache.get(T()); if (c && Date.now() - c.t < 30000) return c.v;
  const v = await rhythmGapNow(); gapCache.set(T(), { t: Date.now(), v }); return v;
}
async function rhythmGapNow() {
  const done = (await db.done(500)).filter(r => r.done_at).map(r => ({ t: Date.parse(r.done_at), r })).sort((a, b) => a.t - b.t);
  const gaps = [];
  for (let i = 1; i < done.length; i++) {
    const g = (done[i].t - done[i - 1].t) / 1000; if (g <= 0 || g > 1200) continue;   // a longer gap is a break, not the rhythm
    gaps.push(g - songSecs(done[i].r.song, done[i].r.artist));
  }
  const last = gaps.slice(-8); if (last.length < 2) return DEF_GAP;
  return Math.min(360, Math.max(20, last.reduce((a, x) => a + x, 0) / last.length));
}
async function etaFor(list, mine) {
  if (!mine || mine.status !== "queued") return null;
  const gap = await rhythmGap(), now = Date.now(), up = list.find(r => r.status === "up");
  let secs = 0;
  if (up) { const u = await upAt(), len = songSecs(up.song, up.artist), el = u && u.id === up.id ? (now - u.at) / 1000 : len / 2; secs += Math.max(30, len - el) + gap; }
  for (const r of list) { if (r.id === mine.id) break; if (r.status === "queued") secs += songSecs(r.song, r.artist) + gap; }
  songSecs(mine.song, mine.artist);
  return { at: now + Math.round(secs) * 1000, min: Math.max(1, Math.round(secs / 60)), gap: Math.round(gap) };
}
// DJ clock: when the last singer on the list should finish, and closing time (2 AM bar time unless set per bar)
async function lastSongEnd() {
  const list = await db.active(), q = list.filter(r => r.status === "queued"), last = q[q.length - 1];
  const day = barDay().date, ch = Number(TEN().closeHour ?? 2), closeAt = barTime(day, ch < 12 ? 24 + ch : ch);
  if (!last) { const up = list.find(r => r.status === "up"); if (!up) return { at: null, closeAt, count: 0 };
    const u = await upAt(), len = songSecs(up.song, up.artist), el = u && u.id === up.id ? (Date.now() - u.at) / 1000 : len / 2;
    return { at: Date.now() + Math.max(30, len - el) * 1000, closeAt, count: 0 }; }
  const e = await etaFor(list, last);
  return { at: e.at + songSecs(last.song, last.artist) * 1000, closeAt, count: q.length };
}
const publicRow = r => ({ id: r.id, name: r.name, song: r.song, artist: r.artist, status: r.status, likes: r.likes || 0 });
const NETS = ["Facebook", "Instagram", "TikTok"];
const postedList = r => String((r && r.posted_to) || "").split(",").filter(x => NETS.includes(x));
const viaOf = r => String(r.device || "").startsWith("kj-") ? "dj" : (r.via || "");
const kjRow = r => ({ ...publicRow(r), posted: postedList(r), via: viaOf(r) });
// customer phones with the app open tonight: counted from the guest page's live updates.
// Kept in memory and saved every minute so a restart doesn't lose the count.
const phones = new Map();   // tenant -> { night, list: { device: [firstSeen, lastSeen, installedApp] } }
async function phoneBook() {
  const t = T(), night = barDay().date; let b = phones.get(t);
  if (!b || b.night !== night) {
    let list = {}; try { list = JSON.parse((await db.getSetting("phones:" + night)) || "{}"); } catch (e) {}
    b = { night, list, dirty: false }; phones.set(t, b);
  }
  return b;
}
async function seenPhone(dev, app) {
  try { const b = await phoneBook(), now = Date.now(), p = b.list[dev]; b.list[dev] = [p ? p[0] : now, now, (p && p[2]) || !!app]; b.dirty = true; } catch (e) {}
}
// a wall-clock time on the bar's day, in the bar's time zone, as epoch ms
function barTime(dateStr, hour) {
  const [y, m, d] = dateStr.split("-").map(Number), guess = Date.UTC(y, m - 1, d, hour);
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: ZONE(), hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(guess)).map(x => [x.type, x.value]));
  const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute);
  return guess - (wall - guess);
}
// "tonight" starts when sign-ups were opened tonight, but never before 6 PM; "today" is everything since 6 AM
async function nightStart() {
  const day = barDay().date, six = barTime(day, 18);
  let o = null; try { o = JSON.parse((await db.getSetting("open_at")) || "null"); } catch (e) {}
  return o && o.night === day && o.at > six ? o.at : six;
}
async function phoneStats() {
  const b = await phoneBook(), now = Date.now(), v = Object.values(b.list), start = await nightStart();
  return { tonight: v.filter(p => p[1] >= start).length, today: v.length, since: start, now: v.filter(p => now - p[1] < 120000).length, app: v.filter(p => p[2]).length };
}
setInterval(() => {
  for (const [t, b] of phones) if (b.dirty) { b.dirty = false; ctx.run({ t }, () => db.setSetting("phones:" + b.night, JSON.stringify(b.list)).catch(() => {})); }
}, 60000);
// tonight's sign-ups by how they came in (QR scan, installed app, link/browser, added by the DJ)
async function signupStats() {
  const night = barDay().date, seen = new Set(), c = { total: 0, qr: 0, app: 0, link: 0, dj: 0, untracked: 0 };
  for (const r of [...await db.active(), ...await db.done(400)]) {
    if (seen.has(r.id) || nightOf(r.created_at) !== night) continue; seen.add(r.id);
    const v = viaOf(r); c.total++; c[v && v in c ? v : "untracked"]++;
  }
  return c;
}

/* ---------- singer photos: a guest's own picture, shown on the TV when they're up (logo when none) ---------- */
// a photo is "ok" (shows everywhere), "hidden" (host blurred it) or "pending" (approve-first mode, waiting on a host)
const photoCache = new Map();   // settings key -> { at, st } (at "" = no photo)
const photoSt = p => !p ? "" : p.hide ? "hidden" : p.ok === false ? "pending" : "ok";
async function getPhoto(dev) { try { const p = JSON.parse((await db.getSetting("photo:" + dev)) || "null"); return p && p.d ? p : null; } catch (e) { return null; } }
async function photoInfo(dev) {
  if (!dev) return { at: "", st: "" };
  const k = SK("photo:" + dev); if (photoCache.has(k)) return photoCache.get(k);
  const p = await getPhoto(dev), v = { at: p ? p.at : "", st: photoSt(p) };
  if (photoCache.size > 5000) photoCache.clear();
  photoCache.set(k, v); return v;
}
// public screens only ever get a photo that's OK to show
async function photoAt(dev) { const v = await photoInfo(dev); return v.st === "ok" ? v.at : ""; }
async function setPhoto(dev, p) { await db.setSetting("photo:" + dev, p ? JSON.stringify(p) : ""); photoCache.set(SK("photo:" + dev), { at: p ? p.at : "", st: photoSt(p) }); }
async function withPhotos(rows, src) { await Promise.all(rows.map(async (o, i) => { o.photo = (await photoAt(src[i].device)) || null; })); return rows; }
// hosts see every photo plus its status and whether that singer's photo button is locked
async function withPhotosKJ(rows, src) { await Promise.all(rows.map(async (o, i) => { const v = await photoInfo(src[i].device); o.photo = v.at || null; o.photoSt = v.st || null; o.photoLock = await photoLocked(src[i].device); })); return rows; }
// photo lock: "night" ends at 6 AM bar time, "always" until a host unlocks
async function getLock(dev) { try { return JSON.parse((await db.getSetting("photolock:" + dev)) || "null"); } catch (e) { return null; } }
async function photoLocked(dev) { const l = dev && await getLock(dev); return !l ? null : l.always ? "always" : l.night === barDay().date ? "night" : null; }
const photoReview = async () => (await db.getSetting("photo_review")) === "on";
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
/* ---------- owner PINs: house (host page), list (app owner: /owner, /watch), bar (Bar Owner app) ----------
   Render holds the starting PINs (KJ_PIN, STAFF_LIST_PIN, BAR_OWNER_PIN). Once someone changes a PIN, or resets it
   with a texted code, the new one is kept hashed in settings and wins. */
const PIN_KINDS = ["house", "list", "bar"];
function startPin(kind) {
  if (kind === "house") return KJ_PIN;
  if (kind === "list") return process.env.STAFF_LIST_PIN || KJ_PIN;
  return process.env.BAR_OWNER_PIN || process.env.STAFF_LIST_PIN || KJ_PIN;
}
async function pinIs(kind, pin) {
  pin = String(pin || "").replace(/\D/g, ""); if (!pin) return false;
  const o = await db.getSetting(kind + "_pin"); if (o) return pinMatches(pin, o);
  return T() === "dive" ? same(pin, startPin(kind)) : pinMatches(pin, TEN().pinHash);
}
// every bar owner must pick their own Bar Owner PIN: until they do, they are on the starting one (The Dive: BAR_OWNER_PIN; other bars: their account PIN)
async function pinIsStarting(kind) { return kind === "bar" && !(await db.getSetting("bar_pin")); }
async function setOwnerPin(kind, pin) {
  // other bars' house PIN is their account PIN (also changed on their Setup page): update it there
  if (T() !== "dive" && kind === "house") { const t = await db.getTenant(T()); if (t) { t.pinHash = hashPin(pin); await saveTenant(t); return; } }
  await db.setSetting(kind + "_pin", hashPin(pin));
}
const hits = new Map();
// stops one phone from spamming sign-ups; the per-address cap is high because many phones share a carrier address
function rateLimited(ip, dev) {
  const t = Date.now(), f = k => { const l = (hits.get(k) || []).filter(x => t - x < 60000); l.push(t); hits.set(k, l); return l.length; };
  return f("d:" + (dev || ip)) > 6 || f("i:" + ip) > 120;
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
  if (req.query.g === "1") seenPhone(device(req, res), req.query.app === "1");
  const list = await db.active();
  const open = (await db.getSetting("open")) !== "no";
  const mine = list.find(r => r.device === d);
  const last = mine ? null : await db.lastSung(d);
  const geofence = geofenceActive(await db.getSetting("geofence")), ps = await pauseState();
  res.json({ venue: TEN().venue || "", lyrics: (await db.getSetting("lyrics")) !== "off", multi: (await db.getSetting("multi")) === "on", open, geofence, paused: ps.paused, pausedUntil: ps.until, queue: await (async () => { const paid = await paidIds(); return (await withPhotos(list.map(publicRow), list)).map(r => paid.has(r.id) ? { ...r, paid: true } : r); })(), mine: mine ? { ...publicRow(mine), spot: list.indexOf(mine), nosong: (await noSongs()).has(mine.id), repeat: (await idSet("repeat_ask")).has(mine.id), eta: await etaFor(list, mine) } : null,
    last: last ? { ...publicRow(last), public: !!last.public } : null, sung: await sungTonightFor(owner(req, res)), bump: await bumpInfo(list, mine) });
}));

app.post("/api/signup", wrap(async (req, res) => {
  const dev = device(req, res), uid = currentUser(req), d = uid ? "c" + uid : dev;
  if ((await db.getSetting("open")) === "no") return res.status(403).json({ error: "Sign-ups are closed for tonight." });
  { const ps = await pauseState(); if (ps.paused) return res.status(403).json({ error: ps.until ? "Sign-ups are paused until " + new Date(ps.until).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: ZONE() }) + ". Try again then." : "Sign-ups are paused for a bit. Try again soon." }); }
  if ((await authOn()) && !currentUser(req)) return res.status(401).json({ error: "signin", message: "Sign in with your phone number first." });
  if (rateLimited(req.ip, dev)) return res.status(429).json({ error: "Too many tries. Wait a minute and try again." });
  if (!(await termsOk(dev))) return res.status(428).json({ error: "terms", message: "Please read and agree to the Terms to sign up." });
  if (geofenceActive()) {   // always: even the QR code needs the phone to be at the bar
    const lat = Number(req.body.lat), lng = Number(req.body.lng), acc = Math.min(Math.max(Number(req.body.acc) || 0, 0), 200);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(403).json({ error: "location", message: "Turn on location so we can see you're at " + TEN().short + ". You must be here to sign up." });
    const away = metersAway(lat, lng);
    if (away - acc > (Number(TEN().radius) || 150)) return res.status(403).json({ error: "far", miles: Math.round(away / 1609.34 * 10) / 10, acc: Math.round(Number(req.body.acc) || 0), message: "You need to be at " + TEN().short + " to sign up." });
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
  const via = req.body.qr && req.body.qr === TEN().qr ? "qr" : req.body.app ? "app" : "link";
  const row = await db.add({ name, song, artist, device: d, via });
  res.json({ ok: true, id: row.id });
}));

/* ---------- favorites + practice list (per person, saved on the server) ---------- */
async function getLists(o) { try { const v = JSON.parse((await db.getSetting("lists:" + o)) || "{}"); return { fav: v.fav || [], practice: v.practice || [] }; } catch (e) { return { fav: [], practice: [] }; } }
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

// a guest changes their own song while waiting (not once they're up)
app.post("/api/mysong", wrap(async (req, res) => {
  const d = owner(req, res), mine = await db.byDevice(d);
  if (!mine) return res.status(404).json({ error: "You're not on the list right now." });
  if (mine.status === "up") return res.status(409).json({ error: "You're up! Ask the DJ to change it." });
  const song = clean(req.body.song, 80), artist = clean(req.body.artist, 60);
  if (!song) return res.status(400).json({ error: "Enter the song." });
  await db.setSong(mine.id, song, artist); await setNoSong(mine.id, false); await clearRepeat(mine.id); res.json({ ok: true });
}));
app.post("/api/cancel", wrap(async (req, res) => {
  const d = owner(req, res), mine = await db.byDevice(d);
  if (!mine) return res.status(404).json({ error: "You're not on the list right now." });
  await db.setStatus(mine.id, "removed");
  res.json({ ok: true });
}));

// /api/rate (old self star-rating) removed: crowd likes replaced it
const histRow = r => ({ id: r.id, name: r.name, song: r.song, artist: r.artist, likes: r.likes || 0, public: !!r.public, at: r.done_at, posted: postedList(r) });
/* ---------- crowd likes: anyone with the app can ❤️ a singer, one like per phone per performance,
   only on the night they sang (while they're up and after). Likes stay with that song forever. ---------- */
const likeBooks = new Map();   // per bar + night: { "id": Set(phone ids) }
async function likeBook(night) {
  const k = T() + "|" + night; let b = likeBooks.get(k);
  if (!b) { let raw = {}; try { raw = JSON.parse((await db.getSetting("likes:" + night)) || "{}"); } catch (e) {} b = new Map(Object.entries(raw).map(([id, l]) => [id, new Set(l)])); likeBooks.set(k, b); if (likeBooks.size > 50) likeBooks.delete(likeBooks.keys().next().value); }
  return b;
}
async function saveLikeBook(night, b) { const o = {}; b.forEach((set, id) => { o[id] = [...set].slice(-2000); }); await db.setSetting("likes:" + night, JSON.stringify(o)); }
async function sungTonightFor(d) {
  const night = barDay().date, b = await likeBook(night), up = (await db.active()).find(r => r.status === "up");
  const rows = (await db.done(40)).filter(r => r.done_at && nightOf(r.done_at) === night).slice(0, 12);
  if (up) rows.unshift(up);
  return rows.map(r => ({ id: r.id, name: r.name, song: r.song, artist: r.artist || "", likes: r.likes || 0, up: r.status === "up", liked: !!(b.get(String(r.id)) && b.get(String(r.id)).has(d)), mine: r.device === d }));
}
const likeHits = new Map();
app.post("/api/like", wrap(async (req, res) => {
  const d = owner(req, res), id = parseInt(req.body.id, 10), r = await db.get(id);
  if (!r || (r.status !== "up" && r.status !== "done")) return res.status(404).json({ error: "That song isn't open for likes." });
  const night = barDay().date;
  if (r.status === "done" && (!r.done_at || nightOf(r.done_at) !== night)) return res.status(409).json({ error: "Likes are only open the night they sang." });
  if (r.device === d) return res.status(409).json({ error: "You can't like your own song." });
  const t = Date.now(), l = (likeHits.get(d) || []).filter(x => t - x < 60000); if (l.length >= 30) return res.status(429).json({ error: "Slow down a little." }); l.push(t); likeHits.set(d, l);
  const b = await likeBook(night), set = b.get(String(id)) || new Set();
  const want = req.body.on !== false;
  if (want === set.has(d)) return res.json({ ok: true, liked: want, likes: r.likes || 0 });
  if (want) set.add(d); else set.delete(d); b.set(String(id), set);
  const likes = await db.addLike(id, want ? 1 : -1); await saveLikeBook(night, b);
  res.json({ ok: true, liked: want, likes });
}));
// the singer's own choice to be on the Wall of Fame (no self-rating anymore)
app.post("/api/wall-optin", wrap(async (req, res) => {
  const d = owner(req, res), r = await db.get(parseInt(req.body.id, 10));
  if (!r || r.device !== d || !r.done_at) return res.status(404).json({ error: "Song not found." });
  await db.setPublic(r.id, !!req.body.public); res.json({ ok: true, public: !!req.body.public });
}));
// links to the singer's own posts, so they can find them again (only shown to them)
const postLinks = r => { try { return JSON.parse((r && r.post_links) || "{}"); } catch (e) { return {}; } };
const NET_HOSTS = { Facebook: /(^|\.)(facebook\.com|fb\.com|fb\.watch)$/i, Instagram: /(^|\.)instagram\.com$/i, TikTok: /(^|\.)tiktok\.com$/i };
app.post("/api/postlink", wrap(async (req, res) => {
  const d = owner(req, res), r = await db.get(parseInt(req.body.id, 10));
  if (!r || r.device !== d) return res.status(404).json({ error: "Song not found." });
  const net = NETS.includes(req.body.net) ? req.body.net : null; if (!net) return res.status(400).json({ error: "Pick an app." });
  const links = postLinks(r), raw = String(req.body.url || "").trim().slice(0, 400);
  if (!raw) delete links[net];
  else {
    let u; try { u = new URL(/^https?:\/\//i.test(raw) ? raw : "https://" + raw); } catch (e) { return res.status(400).json({ error: "That doesn't look like a link." }); }
    if (u.protocol !== "https:" && u.protocol !== "http:") return res.status(400).json({ error: "That doesn't look like a link." });
    if (!NET_HOSTS[net].test(u.hostname)) return res.status(400).json({ error: "That isn't a link to " + net + "." });
    links[net] = u.toString();
  }
  await db.setPostLinks(r.id, JSON.stringify(links));
  const list = postedList(r); if (raw && !list.includes(net)) { list.push(net); await db.setPosted(r.id, list.join(",")); }
  res.json({ ok: true, links, posted: list });
}));
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
  res.json({ items: (await db.mineAll(d, req.query.sort === "top" ? "top" : "new")).map(r => ({ ...histRow(r), links: postLinks(r) })) });
}));
app.get("/api/wall", wrap(async (req, res) => {
  res.json({ items: (await db.history({ onlyPublic: true, sort: req.query.sort === "top" ? "top" : "new", limit: 100 })).map(histRow) });
}));

/* ---------- customer accounts: phone number + text code (Twilio Verify) ---------- */
// user agreement: which version this phone agreed to, and when (kept as a record)
const TERMS_V = "2026-10-05";
const HOST_TERMS_V = "2026-10-04";   // Host, DJ & Staff Terms (terms page, #hostterms)
async function termsOk(dev) { try { return JSON.parse((await db.getSetting("terms:" + dev)) || "{}").v === TERMS_V; } catch (e) { return false; } }
async function recordTerms(req, dev) { const u = currentUser(req); await db.setSetting("terms:" + dev, JSON.stringify({ v: TERMS_V, at: new Date().toISOString(), ip: req.ip, customer: u || null, ua: String(req.headers["user-agent"] || "").slice(0, 200) })); }
app.post("/api/terms", wrap(async (req, res) => {
  if (req.body.v !== TERMS_V || req.body.agree !== true) return res.status(400).json({ error: "Check the box to agree." });
  await recordTerms(req, device(req, res)); res.json({ ok: true, v: TERMS_V });
}));
const PHOTO_RE = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+=*)$/, photoTries = new Map();
function photoBytes(p) { const m = PHOTO_RE.exec(p.d); return m ? { type: "image/" + m[1], buf: Buffer.from(m[2], "base64") } : null; }
app.post("/api/photo", wrap(async (req, res) => {
  const dev = device(req, res), d = owner(req, res);
  if (!(await termsOk(dev))) return res.status(428).json({ error: "terms", message: "Please read and agree to the Terms first." });
  if (await photoLocked(d)) return res.status(403).json({ error: "Photos are turned off for you right now. Ask the host. / Fotos desactivadas, pregunta al host." });
  const now = Date.now(), l = (photoTries.get(req.ip) || []).filter(x => now - x < 600000);
  if (l.length >= 15) return res.status(429).json({ error: "Too many photo changes. Try again later." });
  l.push(now); photoTries.set(req.ip, l);
  const m = PHOTO_RE.exec(String(req.body.data || ""));
  if (!m) return res.status(400).json({ error: "That picture didn't work. Try another one." });
  const buf = Buffer.from(m[2], "base64"), jpg = buf[0] === 0xff && buf[1] === 0xd8, png = buf[0] === 0x89 && buf[1] === 0x50, webp = buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP";
  if (!(jpg || png || webp) || buf.length < 200) return res.status(400).json({ error: "That picture didn't work. Try another one." });
  if (buf.length > 280000) return res.status(413).json({ error: "That picture is too big. Try another one." });
  const at = now.toString(36);
  const review = await photoReview();
  await setPhoto(d, { d: m[0], at, on: new Date(now).toISOString(), ...(review ? { ok: false } : {}) });
  res.json({ ok: true, photo: at, photoSt: review ? "pending" : "ok" });
}));
app.delete("/api/photo", wrap(async (req, res) => { await setPhoto(owner(req, res), null); res.json({ ok: true }); }));
app.get("/api/photo/me", wrap(async (req, res) => {
  const p = await getPhoto(owner(req, res)), b = p && photoBytes(p); if (!b) return res.status(404).end();
  res.set({ "Content-Type": b.type, "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff" }).send(b.buf);
}));
// only singers on tonight's list have a public picture link
app.get("/api/photo/:id", wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10), r = (await db.active()).find(x => x.id === id);
  const p = r && await getPhoto(r.device), b = p && photoSt(p) === "ok" && photoBytes(p); if (!b) return res.status(404).end();
  res.set({ "Content-Type": b.type, "Cache-Control": "public, max-age=600", "X-Content-Type-Options": "nosniff" }).send(b.buf);
}));
app.get("/api/me", wrap(async (req, res) => {
  const u = currentUser(req), c = u ? await db.customer(u) : null, p = await getProfile(device(req, res));
  const dv = device(req, res);
  const pi = await photoInfo(owner(req, res));
  res.json({ photo: pi.at || null, photoSt: pi.st || null, photoLock: await photoLocked(owner(req, res)), terms: TERMS_V, termsOk: await termsOk(dv), auth: await authOn(), user: c ? { name: c.name, phone: "•••-•••-" + c.phone.slice(-4) } : null, profileName: (c && c.name) || (p && p.name) || null });
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
// starting PIN the owner can give every new DJ/staff login (set HOST_TEMP_PIN in Render). Several logins may share it
// until they make their own, so signing in with it asks "which one are you?"
const TEMP_PIN = String(process.env.HOST_TEMP_PIN || "").replace(/\D/g, "");
async function whoIs(pin, name) {
  if (!pin) return null;
  if (await pinIs("house", pin)) return { name: "Owner", admin: true, role: "house" };
  // the Bar Owner PIN (and the app owner's list PIN at The Dive) can run the host page with the house controls
  if (await pinIs("bar", pin)) return { name: "Bar owner", admin: true, role: "house", ownerLogin: true };
  if (T() === "dive" && await pinIs("list", pin)) return { name: "App owner", admin: true, role: "house", ownerLogin: true };
  const hs = (await getHosts()).filter(x => same(pin, x.pin));
  let h = hs[0];
  if (hs.length > 1) { h = name ? hs.find(x => x.name === name) : null; if (!h) return { pick: hs.map(x => x.name) }; }
  return h ? { name: h.name, admin: false, own: h.own === true, agreed: h.agreed === HOST_TERMS_V, role: h.role === "staff" ? "staff" : "dj", manager: h.role === "staff" && h.manager === true } : null;
}
const pinTries = new Map();
async function kjAuth(req, res, next) {
  try {
    const t = Date.now(), l = (pinTries.get(req.ip) || []).filter(x => t - x < 600000);
    if (l.length >= 20) return res.status(429).json({ error: "Too many wrong PINs. Wait 10 minutes." });
    // Analytics also opens with the owner list PIN (app owner) or the Bar Owner PIN: view only, never host controls
    if (req.method === "GET" && /^\/api\/kj\/stats(\?|$)/.test(req.originalUrl)) {
      const pv = String(req.headers["x-kj-pin"] || "");
      if (await pinIs("list", pv)) { req.kj = { name: "App owner", role: "owner", owner: true, admin: false }; return next(); }
      if (await pinIs("bar", pv)) { req.kj = { name: "Bar owner", role: "owner", owner: true, admin: false }; return next(); }
    }
    let nm = ""; try{ nm = decodeURIComponent(String(req.headers["x-kj-name"] || "")); }catch(e){}
    const who = await whoIs(String(req.headers["x-kj-pin"] || ""), nm);
    if (who && who.pick) return res.status(409).json({ error: "Tap your name.", pickName: true, names: who.pick });
    if (!who) { l.push(t); pinTries.set(req.ip, l); return res.status(401).json({ error: "Wrong PIN." }); }
    if (who.role === "dj") { const bad = await djGate(req, who); if (bad) return res.status(bad.status).json(bad.body); }
    // DJ and staff logins start with a PIN the owner made; they must set their own before doing anything else
    // ...and agree to the Host, DJ & Staff Terms
    if (!who.admin && (!who.own || !who.agreed) && !/\/api\/kj\/(state|my-pin|my-phone|logout|host-terms)(\?|$)/.test(req.originalUrl))
      return res.status(403).json({ error: !who.own ? "Set your own PIN first." : "Agree to the Host, DJ & Staff Terms first.", needNewPin: true });
    req.kj = who;
    await djIdleCheck();
    if (req.method === "POST" && !/\/api\/kj\/(where|logout|state)(\?|$)/.test(req.originalUrl)) await djTouch();
    next();
  } catch (e) { console.error(e); res.status(500).json({ error: "Something went wrong. Try again." }); }
}
// one DJ logged in at a time, live until they sign out. DJs must be at the bar to sign in, and the
// session closes if their phone reports it left. Staff / house can close it with one tap.
const hasSpot = () => { const t = TEN(); return t.lat != null && t.lat !== "" && Number.isFinite(Number(t.lat)); };
const DJ_SLACK = 100;   // extra meters past the guest radius before we call it "left" (GPS drifts indoors)
async function djSession() { try { return JSON.parse((await db.getSetting("dj_session")) || "null"); } catch (e) { return null; } }
function djWhere(req) {
  const lat = Number(req.headers["x-kj-lat"]), lng = Number(req.headers["x-kj-lng"]), acc = Math.min(Math.max(Number(req.headers["x-kj-acc"]) || 0, 0), 200);
  return Number.isFinite(lat) && Number.isFinite(lng) && req.headers["x-kj-lat"] ? { lat, lng, acc } : null;
}
const djAway = w => metersAway(w.lat, w.lng) - w.acc > (Number(TEN().radius) || 150) + DJ_SLACK;
async function djGate(req, who) {
  const ds = await djSession(), fresh = req.headers["x-kj-login"] === "1";
  if (ds && ds.name !== who.name) return { status: 423, body: { error: ds.name + " is the DJ right now. They need to sign out, or staff can close their session.", locked: true } };
  if (ds) return null;
  let k = null; try { k = JSON.parse((await db.getSetting("dj_kicked")) || "null"); } catch (e) {}
  if (k && k.name === who.name && !fresh) return { status: 401, body: { error: k.why || "Your DJ session was closed.", kicked: true } };
  if (!fresh) return { status: 401, body: { error: "Your DJ session ended. Sign in again.", kicked: true } };
  if (hasSpot()) {
    const w = djWhere(req);
    if (!w) return { status: 403, body: { error: "DJs sign in from the bar. Allow location so we can check.", needLoc: true } };
    if (djAway(w)) return { status: 403, body: { error: "You need to be at " + (TEN().short || "the bar") + " to sign in as DJ.", far: true } };
  }
  if (k && k.name === who.name) await db.setSetting("dj_kicked", "");
  await db.setSetting("dj_session", JSON.stringify({ name: who.name, since: Date.now() }));
  return null;
}
/* ---------- DJ nights log: every DJ session that ends (signed out, closed by staff/owner, left the bar,
   or auto-closed after 5 hours with no activity), with songs sung and tips collected ---------- */
const DJ_IDLE = 5 * 3600e3;
async function djNightSummary(ds, end) {
  const start = ds.since || end, days = [...new Set([barDay(start).date, barDay(end).date])];
  let tips = [];
  for (const d of days) tips = tips.concat((await getTips(d)).filter(x => x.to === ds.name && x.at >= start && x.at <= end));
  const r2 = v => Math.round(v * 100) / 100, bump = tips.filter(x => x.bump), plain = tips.filter(x => !x.bump);
  let songs = 0; try { songs = (await db.sungSince(start)).filter(r => Date.parse(r.done_at) <= end).length; } catch (e) {}
  return { dj: ds.name, start, end, night: barDay(start).date, songs, tips: r2(plain.reduce((a, x) => a + x.amount, 0)), tipCount: plain.length, moveups: r2(bump.reduce((a, x) => a + x.amount, 0)), moveupCount: bump.length };
}
async function getDjLog() { try { return JSON.parse((await db.getSetting("dj_log")) || "[]"); } catch (e) { return []; } }
async function djTouch() {   // any host action keeps the night alive
  const ds = await djSession(); if (!ds) return;
  if (!ds.last || Date.now() - ds.last > 60000) { ds.last = Date.now(); await db.setSetting("dj_session", JSON.stringify(ds)); }
}
async function djIdleCheck() {
  const ds = await djSession(); if (!ds) return;
  // sessions started before this check existed get a fresh 5 hours instead of closing mid-show
  if (!ds.last) { ds.last = Date.now(); await db.setSetting("dj_session", JSON.stringify(ds)); return; }
  const last = ds.last;
  if (Date.now() - last > DJ_IDLE) await endDj(ds.name, "Your DJ session closed after 5 hours with no activity.", "auto-closed after 5 hours with no activity", last + DJ_IDLE);
}
/* ---------- nightly shutdown at 4 AM bar time, every bar: DJ signed out, list cleared, sign-ups closed.
   Sign-ups reopen on their own at 6 PM (only if this shut them). Runs once per morning even after a restart. ---------- */
function barClock(at) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: ZONE(), hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit" }).formatToParts(new Date(at || Date.now())).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: +p.hour % 24 };
}
async function nightlyClose() {
  const c = barClock();
  if (c.hour >= 4 && c.hour < 18) {
    if ((await db.getSetting("auto_close_day")) === c.date) return;
    await db.setSetting("auto_close_day", c.date);
    const ds = await djSession();
    if (ds) await endDj(ds.name, "The night closed at 4 AM.", "closed at 4 AM (nightly shutdown)");
    const left = (await db.active()).length;
    await db.newNight();
    await db.setSetting("paused", "off");
    if ((await db.getSetting("open")) !== "no") { await db.setSetting("open", "no"); await db.setSetting("auto_closed", c.date); }
    audit("System", "auto", "Nightly 4 AM shutdown: " + (ds ? ds.name + " signed out, " : "") + (left ? left + " left on the list cleared, " : "") + "sign-ups closed until 6 PM");
  } else if (c.hour >= 18 && (await db.getSetting("auto_closed"))) {
    await db.setSetting("auto_closed", "");
    if ((await db.getSetting("open")) === "no") { await db.setSetting("open", "yes"); audit("System", "auto", "Sign-ups reopened at 6 PM"); }
  }
}
async function allBars(fn) {
  await ctx.run({ t: "dive", tenant: DIVE, base: "" }, () => fn().catch(e => console.error("dive:", e.message)));
  let list = []; try { list = await db.listTenants(); } catch (e) {}
  for (const t of list) { if (!t.slug || t.slug === "dive") continue; await ctx.run({ t: t.slug, tenant: t, base: "/b/" + t.slug }, () => fn().catch(e => console.error(t.slug + ":", e.message))); }
}
setInterval(() => { allBars(async () => { await djIdleCheck(); await nightlyClose(); }).catch(() => {}); }, 5 * 60000);
/* ---------- phone alerts (Web Push): "you're next" and "you're up" buzz + sound even when the app is closed.
   iPhone: works once the app is added to the Home Screen (iOS 16.4+). Keys are made once and kept in the database. ---------- */
let vapidPub = "";
async function vapidReady() {
  if (vapidPub) return vapidPub;
  await ctx.run({ t: "dive", tenant: DIVE, base: "" }, async () => {
    let k = null; try { k = JSON.parse((await db.getSetting("vapid_keys")) || "null"); } catch (e) {}
    if (!k || !k.publicKey) { k = webpush.generateVAPIDKeys(); await db.setSetting("vapid_keys", JSON.stringify(k)); }
    webpush.setVapidDetails("https://the-dive-karaoke.onrender.com", k.publicKey, k.privateKey); vapidPub = k.publicKey;
  });
  return vapidPub;
}
app.get("/api/push/key", wrap(async (req, res) => { res.json({ key: await vapidReady() }); }));
app.post("/api/push/sub", wrap(async (req, res) => {
  const sub = req.body && req.body.sub;
  if (!sub || typeof sub.endpoint !== "string" || !/^https:\/\//.test(sub.endpoint) || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) return res.status(400).json({ error: "Alerts didn't turn on. Try again." });
  const clean = { endpoint: sub.endpoint.slice(0, 600), keys: { p256dh: String(sub.keys.p256dh).slice(0, 200), auth: String(sub.keys.auth).slice(0, 100) } };
  await db.setSetting("push:" + owner(req, res), JSON.stringify(clean)); res.json({ ok: true });
}));
app.post("/api/push/off", wrap(async (req, res) => { await db.setSetting("push:" + owner(req, res), ""); res.json({ ok: true }); }));
const pushSentMem = new Map();
async function pushTo(row, stage, title, body) {
  if (!row || !row.device || String(row.device).startsWith("kj-")) return;
  const key = T() + ":" + row.id + ":" + stage + (stage === "nosong" ? ":" + row.song : "");
  if (pushSentMem.has(key)) return; pushSentMem.set(key, Date.now());
  if (pushSentMem.size > 3000) { const cut = Date.now() - 12 * 3600e3; for (const [k, t] of pushSentMem) if (t < cut) pushSentMem.delete(k); }
  let sub = null; try { sub = JSON.parse((await db.getSetting("push:" + row.device)) || "null"); } catch (e) {}
  if (!sub) return;
  await vapidReady();
  try { await webpush.sendNotification(sub, JSON.stringify({ title, body, tag: "dive-" + stage, url: (BASE() || "") + "/" }), { TTL: 600, urgency: "high" }); }
  catch (e) { if (e && (e.statusCode === 404 || e.statusCode === 410)) await db.setSetting("push:" + row.device, ""); }
}
async function pushTick() {
  const list = await db.active(), up = list.find(r => r.status === "up"), q = list.filter(r => r.status === "queued"), song = r => "“" + r.song + "”" + (r.artist ? " – " + r.artist : "");
  if (up) await pushTo(up, "up", "🎤 You're up! / ¡Te toca!", "Head to the stage: " + song(up));
  if (q[0] && (up || q.length > 1)) await pushTo(q[0], "deck", "⏭️ You're next! / ¡Sigues tú!", "Get ready near the stage: " + song(q[0]));
  const ns = await noSongs();
  if (ns.size) { const ask = await idSet("repeat_ask"); for (const r of q) if (ns.has(r.id)) await pushTo(r, "nosong", ask.has(r.id) ? "🔁 Pick a different song" : "🎵 Pick another song", (ask.has(r.id) ? "That song was already sung tonight." : "The DJ doesn't have " + song(r) + ".") + " You keep your spot. Tap to change it."); }
}
setInterval(() => { allBars(pushTick).catch(() => {}); }, 15000);
setTimeout(() => { allBars(async () => { await djIdleCheck(); await nightlyClose(); }).catch(() => {}); }, 20000);
async function endDj(name, why, how, at) {
  const ds = await djSession();
  if (!ds || (name && ds.name !== name)) return null;
  await db.setSetting("dj_session", "");
  try {
    const end = at || Date.now(), row = await djNightSummary(ds, end);
    row.how = how || (why ? why.replace(/ closed your DJ session\.$/, "").replace(/^Your /, "") : "signed out");
    if (!how && why && / closed your DJ session\.$/.test(why)) row.how = "closed by " + why.replace(/ closed your DJ session\.$/, "");
    const log = await getDjLog(); log.push(row); await db.setSetting("dj_log", JSON.stringify(log.slice(-1000)));
    if (how) audit("System", "auto", ds.name + "'s DJ night " + how);
  } catch (e) { console.error("dj log:", e.message); }
  if (why) await db.setSetting("dj_kicked", JSON.stringify({ name: ds.name, at: Date.now(), why }));
  if ((await db.getSetting("tip_host")) === ds.name) await db.setSetting("tip_host", "");
  return ds;
}
const djStrikes = new Map();
app.use("/api/kj", kjAuth);
/* ---------- change log: every change on the host page, Bar Owner app and owner views, and who made it ---------- */
async function getAudit(night) { try { return JSON.parse((await db.getSetting("audit:" + night)) || "[]"); } catch (e) { return []; } }
let auditChain = Promise.resolve();
function audit(who, role, text) {
  if (who === "Owner" && role === "bar owner") who = "Bar owner";
  const t = T(), tenant = TEN(), base = BASE();
  auditChain = auditChain.then(() => ctx.run({ t, tenant, base }, async () => {
    const night = barDay().date, l = await getAudit(night);
    l.push({ at: Date.now(), who: who || "?", role: role || "", text });
    await db.setSetting("audit:" + night, JSON.stringify(l.slice(-3000)));
    let ns = []; try { ns = JSON.parse((await db.getSetting("audit_nights")) || "[]"); } catch (e) {}
    if (!ns.includes(night)) { ns.push(night); await db.setSetting("audit_nights", JSON.stringify(ns.slice(-120))); }
  })).catch(e => console.error("audit:", e.message));
}
const ACT_NAMES = { remove: "removed", done: "marked done", up: "put up to sing (Sing now)", raise: "moved up one", lower: "moved down one", readd: "put back in line", move: "moved", repeatok: "OK'd a repeat song for", repeatno: "asked for a different (repeat) song from", nosong: "marked \"don't have the song\" for", hassong: "undid \"don't have the song\" for", lock: "locked the spot of", unlock: "unlocked the spot of" };
async function describeKj(req) {
  const u = req.originalUrl.split("?")[0], b = req.body || {}, on = v => v ? "on" : "off";
  const nm = async id => { try { const r = await db.get(parseInt(id, 10)); return r ? r.name + (r.song ? " (" + r.song + ")" : "") : "#" + id; } catch (e) { return "#" + id; } };
  let m;
  if (u === "/api/kj/next") return "Next singer";
  if (u === "/api/kj/undo-next") return "Undo next singer";
  if (u === "/api/kj/add") return "Added singer " + (b.name || "") + " – " + (b.song || "") + (b.spot ? " at #" + b.spot : "") + (b.lock ? " (locked)" : "");
  if ((m = u.match(/^\/api\/kj\/(\d+)\/song$/))) return "Changed song for " + ((await db.get(parseInt(m[1], 10))) || {}).name + " to " + (b.song || "") + (b.artist ? " – " + b.artist : "");
  if ((m = u.match(/^\/api\/kj\/(\d+)\/rename$/))) return "Renamed " + await nm(m[1]) + " to " + (b.name || "");
  if ((m = u.match(/^\/api\/kj\/bump\/(\w+)$/))) return (b.ok ? "Approved" : "Denied") + " a paid move-up";
  if ((m = u.match(/^\/api\/kj\/(\d+)\/(\w+)$/))) return (ACT_NAMES[m[2]] || m[2]).replace(/^./, c => c.toUpperCase()) + " " + await nm(m[1]) + (b.spot ? " to #" + b.spot : "");
  if ((m = u.match(/^\/api\/kj\/photo\/(\d+)\/(\w+)$/))) return "Photo " + m[2] + " for " + await nm(m[1]);
  const fixed = {
    "/api/kj/kick": "Closed the DJ's session", "/api/kj/logout": "Signed out", "/api/kj/my-pin": "Changed " + (req.kj && req.kj.admin ? "the house PIN" : "their own PIN"),
    "/api/kj/my-phone": "Saved a Forgot-PIN phone", "/api/kj/host-terms": "Agreed to the host terms", "/api/kj/tips/links": "Updated their payment links",
    "/api/kj/tips/take": (b.on ? "Started" : "Stopped") + " taking tips", "/api/kj/tips/staff": (b.on ? "Turned tips back on" : "Stopped tips tonight"),
    "/api/kj/bump-price": "Set move-up price to $" + b.price + " a spot", "/api/kj/hosts": "Added login " + (b.name || ""), "/api/kj/hosts/reset": "Reset the PIN for " + (b.name || ""),
    "/api/kj/hosts/remove": "Removed login " + (b.name || ""), "/api/kj/hosts/role": "Made " + (b.name || "") + " " + (b.role || ""), "/api/kj/hosts/manager": (b.on ? "Made " : "Removed manager from ") + (b.name || "") + (b.on ? " a manager" : ""),
    "/api/kj/promos": "Saved an ad", "/api/kj/promos/remove": "Removed an ad", "/api/kj/venue": "Set tonight's venue",
    "/api/kj-open": "Sign-ups " + (b.open ? "opened" : "closed"), "/api/kj-lyrics": "Lyrics " + on(b.on), "/api/kj-multi": "One song per person on the queue " + on(!b.on),
    "/api/kj-photoreview": "Approve photos first " + on(b.on), "/api/kj-phone": "Phone sign-in " + on(b.on), "/api/kj-pause": b.minutes ? "Paused sign-ups" + (b.minutes > 0 ? " for " + b.minutes + " min" : "") : "Resumed sign-ups", "/api/kj-newnight": "Started a new night"
  };
  return fixed[u] || null;
}
function auditKj(req, res, next) {
  if (req.method === "POST" && !/\/api\/kj\/(where|state)(\?|$)/.test(req.originalUrl)) {
    res.on("finish", () => { if (res.statusCode < 400 && req.kj) describeKj(req).then(t => { if (t) audit(req.kj.ownerLogin ? req.kj.name : req.kj.admin ? "House PIN" : req.kj.name, req.kj.admin ? "house" : req.kj.manager ? "manager" : req.kj.role, t); }).catch(() => {}); });
  }
  next();
}
app.use("/api/kj", auditKj);
/* ---------- daily ads / promos ---------- */
async function getPromos() { try { return JSON.parse((await db.getSetting("promos")) || "[]"); } catch (e) { return []; } }
// the bar's "day" runs 6 AM to 6 AM, McAllen time
function barDay(at) {
  const t = new Date((at || Date.now()) - 6 * 3600 * 1000);
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
  const djNow = await djSession();
  res.json({ lastSong: await lastSongEnd().catch(() => null), myPhone: req.kj.admin ? maskPhone(await recoveryPhone("house")) : maskPhone(((await getHosts()).find(h => h.name === req.kj.name) || {}).phone || ""), undo: (await nextUndo()).length, bumps: await bumpsFor(req.kj), bumpOn: await bumpOn(), bumpPrice: seesBumps(req.kj) ? await bumpPrice() : null, signups: (req.kj.admin || req.kj.manager) ? await signupStats() : null, phones: (req.kj.admin || req.kj.manager) ? await phoneStats() : null, me: req.kj, tempPin: req.kj.admin ? TEMP_PIN : "", hostTermsV: HOST_TERMS_V, lyrics: (await db.getSetting("lyrics")) !== "off", djOn: djNow ? djNow.name : null, multi: (await db.getSetting("multi")) === "on", open: (await db.getSetting("open")) !== "no", geofence: geofenceActive(await db.getSetting("geofence")), hasSpot: TEN().lat != null && TEN().lat !== "", tenant: tenantPublic(TEN()), plan: planSummary(TEN()), hostLimit: TEN().house ? null : HOST_LIMIT, pause: await pauseState(), phoneSignin: await authOn(), twilioReady: TW_READY, photoReview: await photoReview(), queue: await (async () => { const l = await db.active(), paid = await paidIds(), ns = await noSongs(), rp = await repeatsFor(l), rOk = await idSet("repeat_ok"), rAsk = await idSet("repeat_ask"), man = new Set((await getBumps()).filter(b => b.status === "approved" && b.manual).map(b => b.sid)); return (await withPhotosKJ(l.map(kjRow), l)).map(r => ({ ...r, ...(paid.has(r.id) ? { paid: true } : {}), ...(man.has(r.id) ? { djLock: true } : {}), ...(ns.has(r.id) ? { nosong: true } : {}), ...(rAsk.has(r.id) && ns.has(r.id) ? { repeatAsk: true } : rp.has(r.id) && !rOk.has(r.id) && r.status === "queued" ? { repeat: rp.get(r.id) } : {}) })); })(), done: (await db.done(500)).map(kjRow) });
}));
// everything we know about the singer on this row: past songs, nights, ratings, posts
app.post("/api/kj/photo/:id/remove", wrap(async (req, res) => {
  const r = await db.get(parseInt(req.params.id, 10)); if (!r) return res.status(404).json({ error: "Not found." });
  await setPhoto(r.device, null); res.json({ ok: true });
}));
// the host's own look at a photo, even one that's blurred or waiting
app.get("/api/kj/photo/:id", wrap(async (req, res) => {
  const r = await db.get(parseInt(req.params.id, 10)), p = r && await getPhoto(r.device), b = p && photoBytes(p); if (!b) return res.status(404).end();
  res.set({ "Content-Type": b.type, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" }).send(b.buf);
}));
// blur = pull it off every screen now; show = approve / unblur
app.post("/api/kj/photo/:id/:act(blur|show)", wrap(async (req, res) => {
  const r = await db.get(parseInt(req.params.id, 10)); if (!r) return res.status(404).json({ error: "Not found." });
  const p = await getPhoto(r.device); if (!p) return res.status(404).json({ error: "No photo." });
  if (req.params.act === "blur") { p.hide = true; p.by = req.kj.name; }
  else { if (await photoLocked(r.device)) return res.status(400).json({ error: "Unlock their photo button first." }); delete p.hide; p.ok = true; }
  await setPhoto(r.device, p); res.json({ ok: true });
}));
// lock this singer's photo button: "night", "always" or "off"
app.post("/api/kj/photo/:id/lock", wrap(async (req, res) => {
  const r = await db.get(parseInt(req.params.id, 10)); if (!r) return res.status(404).json({ error: "Not found." });
  const m = String((req.body || {}).mode || "");
  if (m === "off") await db.setSetting("photolock:" + r.device, "");
  else if (m === "night" || m === "always") {
    await db.setSetting("photolock:" + r.device, JSON.stringify(m === "always" ? { always: true, by: req.kj.name } : { night: barDay().date, by: req.kj.name }));
    const p = await getPhoto(r.device); if (p && !p.hide) { p.hide = true; p.by = req.kj.name; await setPhoto(r.device, p); }
  } else return res.status(400).json({ error: "Pick tonight, always or off." });
  res.json({ ok: true });
}));
app.get("/api/kj/singer/:id", wrap(async (req, res) => {
  const r = await db.get(parseInt(req.params.id, 10)); if (!r) return res.status(404).json({ error: "Not found." });
  const past = (await db.mineAll(r.device, "new")).filter(x => x.id !== r.id);
  const nightOf = t => new Date(new Date(t).getTime() - 6 * 3600e3).toLocaleDateString("en-CA", { timeZone: ZONE() });
  const tonight = nightOf(Date.now());
  const nights = new Set(past.map(x => nightOf(x.done_at))), before = past.filter(x => nightOf(x.done_at) !== tonight);
  const counts = {};
  past.forEach(x => { const k = x.song + "|" + (x.artist || ""); counts[k] = (counts[k] || 0) + 1; });
  const fav = Object.entries(counts).sort((a, b) => b[1] - a[1]).filter(e => e[1] > 1).slice(0, 3).map(([k, n]) => { const i = k.lastIndexOf("|"); return { song: k.slice(0, i), artist: k.slice(i + 1), times: n }; });
  res.json({
    name: r.name, songs: past.length, nights: nights.size, tonight: past.length - before.length,
    firstVisit: past.length ? past[past.length - 1].done_at : null, lastVisit: before.length ? before[0].done_at : null,
    likes: past.reduce((a, x) => a + (x.likes || 0), 0),
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
  // ranges: rolling 7/30/90 days, this week (since Monday) or this month (since the 1st), by karaoke night; all time
  const rq = String(req.query.range || ""), today = barDay().date;
  let since = 0, days = { "7": 7, "30": 30, "90": 90 }[rq] || 0;
  if (days) since = Date.now() - days * 864e5;
  else if (rq === "week") { const d = new Date(today + "T12:00:00Z"), back = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - back); since = barTime(d.toISOString().slice(0, 10), 6); days = back + 1; }
  else if (rq === "month") { since = barTime(today.slice(0, 8) + "01", 6); days = Number(today.slice(8, 10)); }
  const rows = await db.sungSince(since);
  const nights = new Map(), hours = new Array(24).fill(0), singers = new Map(), songs = new Map(), artists = new Map();
  let likes = 0, onWall = 0;
  for (const r of rows) {
    const n = nightOf(r.done_at); nights.set(n, (nights.get(n) || 0) + 1);
    hours[hourOf(r.done_at)]++;
    likes += r.likes || 0;
    if (r.public) onWall++;
    const who = singers.get(r.device) || { name: r.name, songs: 0, likes: 0, nights: new Set(), last: r.done_at };
    who.name = r.name; who.songs++; who.nights.add(n); who.last = r.done_at; who.likes += r.likes || 0;
    singers.set(r.device, who);
    const sk = r.song.toLowerCase() + "|" + (r.artist || "").toLowerCase();
    const so = songs.get(sk) || { song: r.song, artist: r.artist, count: 0 }; so.count++; songs.set(sk, so);
    if (r.artist) { const ak = r.artist.toLowerCase(); const ar = artists.get(ak) || { artist: r.artist, count: 0 }; ar.count++; artists.set(ak, ar); }
  }
  const singerList = [...singers.values()].map(x => ({ name: x.name, songs: x.songs, nights: x.nights.size, likes: x.likes, last: x.last }));
  const nightList = [...nights.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-31).map(([night, count]) => ({ night, count }));
  res.json({
    range: rq || "all",
    totals: { songs: rows.length, singers: singers.size, nights: nights.size, repeat: singerList.filter(x => x.nights > 1).length,
              likes, likesPerSong: rows.length ? Math.round(likes / rows.length * 10) / 10 : 0, onWall, perNight: nights.size ? Math.round(rows.length / nights.size * 10) / 10 : 0 },
    nights: nightList, hours,
    topSingers: singerList.slice().sort((a, b) => b.songs - a.songs || b.likes - a.likes || b.nights - a.nights).slice(0, 15),
    topLiked: singerList.filter(x => x.likes > 0).sort((a, b) => b.likes - a.likes || b.songs - a.songs).slice(0, 15),
    topSongs: [...songs.values()].sort((a, b) => b.count - a.count).slice(0, 15),
    topArtists: [...artists.values()].sort((a, b) => b.count - a.count).slice(0, 10),
    tips: (req.kj.owner || req.kj.manager) ? await tipStats(days) : req.kj.role === "dj" ? await tipStats(days, req.kj.name) : null
  });
}));
const ownerOnly = (req, res, next) => req.kj && req.kj.admin ? next() : res.status(403).json({ error: "Only the house PIN can add logins or change their type." });
const staffOnly = (req, res, next) => req.kj && req.kj.role !== "dj" ? next() : res.status(403).json({ error: "Only staff can do that." });
app.get("/api/kj/hosts", staffOnly, wrap(async (req, res) => { res.json({ hosts: (await getHosts()).map(h => ({ name: h.name, pin: "••" + h.pin.slice(-2), role: h.role === "staff" ? "staff" : "dj", manager: h.role === "staff" && h.manager === true })) }); }));
// house PIN can make a staff login a bar manager: sees all tips and tip totals like the owner
app.post("/api/kj/hosts/manager", ownerOnly, wrap(async (req, res) => {
  const hosts = await getHosts(), h = hosts.find(x => x.name === String(req.body.name || ""));
  if (!h) return res.status(404).json({ error: "Login not found." });
  if (h.role !== "staff") return res.status(400).json({ error: "Only staff logins can be managers. Tap Make staff first." });
  h.manager = !!req.body.on; await db.setSetting("hosts", JSON.stringify(hosts)); res.json({ ok: true });
}));
app.post("/api/kj/hosts", ownerOnly, wrap(async (req, res) => {
  const name = clean(req.body.name, 30), pin = String(req.body.pin || "").replace(/\D/g, "") || TEMP_PIN;
  if (!name) return res.status(400).json({ error: "Enter the host's name." });
  if (pin.length < 4 || pin.length > 8) return res.status(400).json({ error: "PIN must be 4 to 8 digits." });
  const hosts = await getHosts();
  const isTemp = !!TEMP_PIN && pin === TEMP_PIN;
  if (isTemp ? (await whoIs(pin) || {}).admin : ((await whoIs(pin)) || hosts.some(h => h.pin === pin))) return res.status(409).json({ error: "That PIN is already used. Pick another." });
  if (T() !== "dive" && req.body.role !== "staff" && hosts.filter(h => h.role !== "staff").length >= HOST_LIMIT) return res.status(403).json({ error: "Your plan includes " + HOST_LIMIT + " DJ logins. Remove one to add another." });
  if (hosts.some(h => h.name.toLowerCase() === name.toLowerCase())) return res.status(409).json({ error: "There's already a host with that name." });
  hosts.push({ name, pin, own: false, role: req.body.role === "staff" ? "staff" : "dj" }); await db.setSetting("hosts", JSON.stringify(hosts)); res.json({ ok: true });
}));
app.post("/api/kj/host-terms", wrap(async (req, res) => {
  if (req.kj.admin) return res.json({ ok: true });
  if (req.body.agree !== true || req.body.v !== HOST_TERMS_V) return res.status(400).json({ error: "Check the box to agree." });
  const hosts = await getHosts(), me = hosts.find(h => h.name === req.kj.name); if (!me) return res.status(404).json({ error: "Login not found." });
  me.agreed = HOST_TERMS_V; me.agreedAt = new Date().toISOString(); me.agreedIp = req.ip; await db.setSetting("hosts", JSON.stringify(hosts));
  res.json({ ok: true });
}));
app.post("/api/kj/my-pin", wrap(async (req, res) => {
  const pin = String(req.body.pin || "").replace(/\D/g, ""), hosts = await getHosts();
  if (req.kj.admin) {   // the house PIN: changed here by whoever knows it (kept hashed; Render's KJ_PIN is only the starting one)
    if (pin.length < 4 || pin.length > 8) return res.status(400).json({ error: "PIN must be 4 to 8 digits." });
    if (pin === TEMP_PIN || hosts.some(h => h.pin === pin)) return res.status(409).json({ error: "That PIN is taken. Pick another." });
    await setOwnerPin("house", pin); return res.json({ ok: true, house: true });
  }
  if (pin.length < 4 || pin.length > 8) return res.status(400).json({ error: "PIN must be 4 to 8 digits." });
  if (TEMP_PIN && pin === TEMP_PIN) return res.status(409).json({ error: "That's the starting PIN. Pick your own." });
  const taken = await whoIs(pin);
  if ((taken && taken.admin) || hosts.some(h => h.pin === pin && h.name !== req.kj.name)) return res.status(409).json({ error: "That PIN is taken. Pick another." });
  const me = hosts.find(h => h.name === req.kj.name); if (!me) return res.status(404).json({ error: "Host not found." });
  me.pin = pin; me.own = true; await db.setSetting("hosts", JSON.stringify(hosts)); res.json({ ok: true });
}));
app.post("/api/kj/hosts/reset", staffOnly, wrap(async (req, res) => {
  const name = String(req.body.name || ""), pin = String(req.body.pin || "").replace(/\D/g, "") || TEMP_PIN, hosts = await getHosts();
  const h = hosts.find(x => x.name === name); if (!h) return res.status(404).json({ error: "Login not found." });
  if (pin.length < 4 || pin.length > 8) return res.status(400).json({ error: "PIN must be 4 to 8 digits." });
  const taken = await whoIs(pin), isTemp = !!TEMP_PIN && pin === TEMP_PIN;
  if ((taken && taken.admin) || (!isTemp && hosts.some(x => x.pin === pin && x.name !== name))) return res.status(409).json({ error: "That PIN is already used. Pick another." });
  h.pin = pin; h.own = false; await db.setSetting("hosts", JSON.stringify(hosts));
  await endDj(name, "Your PIN was reset. Sign in with the new PIN and change it.");
  res.json({ ok: true });
}));
// switch a login between DJ and staff (house PIN only). A DJ moved to staff loses tips and their DJ session.
app.post("/api/kj/hosts/role", ownerOnly, wrap(async (req, res) => {
  const name = String(req.body.name || ""), role = req.body.role === "staff" ? "staff" : "dj", hosts = await getHosts();
  const h = hosts.find(x => x.name === name); if (!h) return res.status(404).json({ error: "Login not found." });
  if (role === "dj" && h.role === "staff" && T() !== "dive" && hosts.filter(x => x.role !== "staff").length >= HOST_LIMIT) return res.status(403).json({ error: "Your plan includes " + HOST_LIMIT + " DJ logins. Remove one first." });
  h.role = role; await db.setSetting("hosts", JSON.stringify(hosts));
  if (role === "staff") { if ((await db.getSetting("tip_host")) === name) await db.setSetting("tip_host", ""); await endDj(name, "Your login is now a staff login."); }
  res.json({ ok: true });
}));
app.post("/api/kj/hosts/remove", staffOnly, wrap(async (req, res) => {
  const name = String(req.body.name || ""), hosts = (await getHosts()).filter(h => h.name !== name);
  await db.setSetting("hosts", JSON.stringify(hosts)); await db.setSetting("tiplinks:" + name, "{}"); if ((await db.getSetting("tip_host")) === name) await db.setSetting("tip_host", ""); await endDj(name, "Your login was removed."); res.json({ ok: true });
}));
/* ---------- tip the DJ: each host links their own Cash App / Venmo / PayPal / Zelle / Apple Cash ----------
   We never touch the money. A guest picks an amount + leaves a comment, we log it for the host,
   then hand them off to the host's payment app. Totals = what guests tapped, not confirmed payments. */
const TIP_KEYS = ["cashapp", "venmo", "paypal", "zelle", "apple"];
function cleanTipLinks(b) {
  b = b || {}; const o = {};
  const cash = String(b.cashapp || "").trim().replace(/^\$/, "");
  if (cash) { if (!/^[A-Za-z][A-Za-z0-9_-]{0,19}$/.test(cash)) throw new Error("Cash App tag looks wrong. Example: $DJSteve"); o.cashapp = cash; }
  const ven = String(b.venmo || "").trim().replace(/^@/, "");
  if (ven) { if (!/^[A-Za-z0-9_-]{2,30}$/.test(ven)) throw new Error("Venmo username looks wrong. Example: @DJ-Steve"); o.venmo = ven; }
  const pp = String(b.paypal || "").trim().replace(/^https?:\/\/(www\.)?paypal\.me\//i, "").replace(/\/.*$/, "");
  if (pp) { if (!/^[A-Za-z0-9]{1,20}$/.test(pp)) throw new Error("PayPal.me name looks wrong. Example: DJSteve"); o.paypal = pp; }
  const contact = (v, label) => {
    v = String(v || "").trim(); if (!v) return null;
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) && v.length <= 80) return v.toLowerCase();
    const p = normPhone(v); if (p) return p;
    throw new Error(label + " needs the phone number or email it's set up with.");
  };
  const z = contact(b.zelle, "Zelle"); if (z) o.zelle = z;
  const a = contact(b.apple, "Apple Cash"); if (a) o.apple = a;
  return o;
}
async function getTipLinks(name) { try { return JSON.parse((await db.getSetting("tiplinks:" + name)) || "{}"); } catch (e) { return {}; } }
// the owner's master switch: tips + lock-your-spot off for everyone until turned back on
async function moneyOff() { return (await db.getSetting("money_off")) === "on"; }
async function tipState() {
  if (await moneyOff()) return { on: false, killed: true };
  let host = await db.getSetting("tip_host");
  // tips are on automatically for the DJ signed in (once they've saved payment links), unless the DJ
  // stopped them or staff turned them off tonight
  if (!host) {
    const ds = await djSession(), off = await tipsOff();
    if (ds && !(off && off.name === ds.name && off.night === barDay().date)) host = ds.name;
  }
  if (!host || host === "Owner") return { on: false };
  const links = await getTipLinks(host);
  return Object.keys(links).length ? { on: true, host, links } : { on: false };
}
async function tipsOff() { try { return JSON.parse((await db.getSetting("tips_off")) || "null"); } catch (e) { return null; } }
async function setTipsOff(name) { await db.setSetting("tips_off", name ? JSON.stringify({ name, night: barDay().date }) : ""); }
async function getTipNights() { try { return JSON.parse((await db.getSetting("tip_nights")) || "[]"); } catch (e) { return []; } }
async function getTips(night) { try { return JSON.parse((await db.getSetting("tips:" + night)) || "[]"); } catch (e) { return []; } }
const tipHits = new Map();
// guest side
app.get("/api/tip", wrap(async (req, res) => {
  const s = await tipState(); if (!s.on) return res.json({ on: false });
  const p = await getProfile(device(req, res));
  res.json({ on: true, host: s.host === "Owner" ? "the KJ" : s.host, links: s.links, name: (p && p.name) || "" });
}));
app.post("/api/tip", wrap(async (req, res) => {
  // limits per phone, plus a high per-connection cap (the whole bar can share one Wi-Fi address)
  const t = Date.now(), dk = "d:" + device(req, res), ik = "i:" + req.ip;
  const l = (tipHits.get(dk) || []).filter(x => t - x < 600000), li = (tipHits.get(ik) || []).filter(x => t - x < 600000);
  if (l.length >= 8 || li.length >= 80) return res.status(429).json({ error: "That's a lot of tips! Wait a few minutes." });
  const s = await tipState(); if (!s.on) return res.status(409).json({ error: "Tips aren't open right now." });
  const b = req.body || {}, method = String(b.method || "");
  if (!TIP_KEYS.includes(method) || !s.links[method]) return res.status(400).json({ error: "Pick how you want to pay." });
  const amount = Math.round(Number(b.amount) * 100) / 100;
  if (!(amount >= 1 && amount <= 500)) return res.status(400).json({ error: "Tip between $1 and $500." });
  const name = cleanName(b.name, 30) || "Someone", comment = clean(b.comment, 140);
  l.push(t); tipHits.set(dk, l); li.push(t); tipHits.set(ik, li);
  const night = barDay().date, list = await getTips(night);
  list.push({ at: t, who: owner(req, res), name, amount, method, comment, to: s.host });
  await db.setSetting("tips:" + night, JSON.stringify(list.slice(-500)));
  const nights = await getTipNights(); if (!nights.includes(night)) { nights.push(night); await db.setSetting("tip_nights", JSON.stringify(nights)); }
  res.json({ ok: true });
}));
// host side
app.get("/api/kj/tips", wrap(async (req, res) => {
  // tip money: the owner (house PIN) sees every DJ's tips with a per-DJ total, a DJ sees only their own, staff see none
  const s = await tipState(), all = await getTips(barDay().date), dj = req.kj.role === "dj", owner = false;   // tip money lives in the Bar Owner app now
  const list = owner ? all : dj ? all.filter(x => x.to === req.kj.name) : [];
  const byDj = {}; if (owner) all.forEach(x => { byDj[x.to] = Math.round(((byDj[x.to] || 0) + x.amount) * 100) / 100; });
  const ds = await djSession(), off = await tipsOff();
  res.json({ stopped: !!(ds && off && off.name === ds.name && off.night === barDay().date), role: req.kj.role, dj: ds ? ds.name : null, house: req.kj.role !== "dj", needPin: req.kj.role === "dj" && !req.kj.own, mine: req.kj.role !== "dj" ? {} : await getTipLinks(req.kj.name), on: s.on, host: s.on ? s.host : null, owner, seeMoney: owner || dj, tonight: list.slice().reverse(), byDj: owner ? byDj : null, total: Math.round(list.reduce((a, x) => a + x.amount, 0) * 100) / 100 });
}));
app.post("/api/kj/tips/links", wrap(async (req, res) => {
  if (req.kj.admin) return res.status(403).json({ error: "The house PIN is shared, so it can't take tips. Add yourself in Hosts with your own PIN, then log in with that." });
  if (req.kj.role === "staff") return res.status(403).json({ error: "Staff logins can't take tips. Only DJs can." });
  if (!req.kj.own) return res.status(403).json({ error: "Change your PIN first so only you know it. Tap Change my PIN." });
  let links; try { links = cleanTipLinks(req.body); } catch (e) { return res.status(400).json({ error: e.message }); }
  await db.setSetting("tiplinks:" + req.kj.name, JSON.stringify(links));
  if (!Object.keys(links).length && (await db.getSetting("tip_host")) === req.kj.name) await db.setSetting("tip_host", "");
  res.json({ ok: true, links });
}));
app.post("/api/kj/tips/take", wrap(async (req, res) => {
  if (req.kj.role !== "dj") return res.status(403).json({ error: "Only the DJ controls their tips. Close their session to stop them." });
  if (!req.body.on) { if ((await db.getSetting("tip_host")) === req.kj.name) await db.setSetting("tip_host", ""); await setTipsOff(req.kj.name); return res.json({ ok: true }); }
  if (req.kj.admin) return res.status(403).json({ error: "The house PIN is shared, so it can't take tips. Log in with your own host PIN." });
  if (req.kj.role === "staff") return res.status(403).json({ error: "Staff logins can't take tips. Only DJs can." });
  if (!req.kj.own) return res.status(403).json({ error: "Change your PIN first so only you know it." });
  if (!Object.keys(await getTipLinks(req.kj.name)).length) return res.status(400).json({ error: "Add at least one payment link first." });
  await db.setSetting("tip_host", req.kj.name); await setTipsOff(null); res.json({ ok: true });
}));
// staff or the house can stop the DJ's tips for tonight (and turn them back on)
app.post("/api/kj/tips/staff", wrap(async (req, res) => {
  if (req.kj.role === "dj") return res.status(403).json({ error: "Only staff can do that." });
  const ds = await djSession(), s = await tipState();
  if (req.body.on) { await setTipsOff(null); return res.json({ ok: true }); }
  const who = s.on ? s.host : ds ? ds.name : null; if (!who) return res.json({ ok: true });
  if ((await db.getSetting("tip_host")) === who) await db.setSetting("tip_host", "");
  await setTipsOff(who); res.json({ ok: true });
}));
/* ---------- pay to move up: $1 a spot, paid to the DJ through their tip links ----------
   A singer can only move themselves. We can't see the payment, so the request waits until the
   DJ (or the owner / a manager) checks their payment app and taps Approve. The owner can turn it off from the live view. */
const BUMP_PRICE = 1;   // default; the DJ sets their own price per spot
async function bumpPrice() { const v = parseInt(await db.getSetting("bump_price"), 10); return v >= 1 && v <= 50 ? v : BUMP_PRICE; }
async function bumpOn() { return (await db.getSetting("bump")) !== "off" && !(await moneyOff()); }
const BUMP_WAIT = 10 * 60e3;   // a request the DJ never answers drops after 10 minutes so the singer can try again
async function getBumps(night) {
  let l; try { l = JSON.parse((await db.getSetting("bumps:" + (night || barDay().date))) || "[]"); } catch (e) { return []; }
  const t = Date.now(); l.forEach(b => { if (b.status === "pending" && t - b.at > BUMP_WAIT) b.status = "expired"; });
  return l;
}
async function saveBumps(list) { await db.setSetting("bumps:" + barDay().date, JSON.stringify(list.slice(-300))); }
// count by the line order everyone sees (positions can tie after hand edits, so don't compare numbers)
function queuedAhead(list, row) { const i = list.findIndex(r => r.id === row.id); return i < 0 ? 0 : list.slice(0, i).filter(r => r.status === "queued").length; }
async function bumpInfo(list, mine) {
  const s = await tipState(), on = (await bumpOn()) && s.on;
  if (!on) return { on: false };
  const out = { on: true, price: await bumpPrice(), host: s.host, links: s.links };
  if (mine && mine.status === "queued") {
    out.max = queuedAhead(list, mine);
    // locked (paid) spots ahead can't be bought; show their numbers the way the singer sees the line
    { const paid = await paidIds(), up = list.some(r => r.status === "up") ? 1 : 0, q = list.filter(r => r.status === "queued"), me = q.findIndex(r => r.id === mine.id);
      out.locked = q.map((r, k) => k < me && paid.has(r.id) ? k + 1 + up : 0).filter(Boolean);
      let f = 1; q.forEach((r, k) => { if (k < me && paid.has(r.id)) f = Math.max(f, k + 1); }); out.max = Math.max(0, me - f); }   // next up is never jumped
    const req = (await getBumps()).filter(b => b.sid === mine.id).pop();
    if (req) out.req = { status: req.status, spots: req.spots, amount: req.amount, manual: !!req.manual };
  }
  return out;
}
const bumpHits = new Map();
app.post("/api/bump", wrap(async (req, res) => {
  const t = Date.now(), dk = device(req, res), l = (bumpHits.get(dk) || []).filter(x => t - x < 600000);
  if (l.length >= 6) return res.status(429).json({ error: "Too many tries. Wait a few minutes." });
  const list = await db.active(), d = owner(req, res), mine = list.find(r => r.device === d);
  if (!mine || mine.status !== "queued") return res.status(409).json({ error: "You need to be waiting in line to move up." });
  const info = await bumpInfo(list, mine);
  if (!info.on) return res.status(409).json({ error: "Moving up isn't open right now." });
  if (info.req && info.req.status === "pending") return res.status(409).json({ error: "You already have a request waiting for the DJ." });
  const spots = parseInt(req.body.spots, 10), method = String(req.body.method || "");
  if (!(spots >= 1 && spots <= info.max)) return res.status(400).json({ error: info.max ? "Pick 1 to " + info.max + " spots." : "You're already next." });
  if (!TIP_KEYS.includes(method) || !info.links[method]) return res.status(400).json({ error: "Pick how you want to pay." });
  l.push(t); bumpHits.set(dk, l);
  const amount = spots * info.price, all = await getBumps();
  all.push({ id: crypto.randomBytes(5).toString("hex"), at: t, sid: mine.id, name: mine.name, spots, amount, method, to: info.host, status: "pending" });
  await saveBumps(all);
  res.json({ ok: true, amount, to: info.links[method], host: info.host });
}));
app.post("/api/bump/cancel", wrap(async (req, res) => {
  const list = await db.active(), d = owner(req, res), mine = list.find(r => r.device === d);
  if (!mine) return res.json({ ok: true });
  const all = await getBumps(); all.forEach(b => { if (b.sid === mine.id && b.status === "pending") { b.status = "canceled"; b.by = "the singer"; } });
  await saveBumps(all); res.json({ ok: true });
}));
// host side: the DJ who gets the money, the owner and managers can see and approve requests (staff can't see money)
const seesBumps = k => !!(k && k.role === "dj");   // money: only the DJ on the host page (owners use the Bar Owner app)
async function bumpsFor(k) {
  if (!seesBumps(k)) return null;
  const all = await getBumps(), act = await db.active(), live = new Set(act.filter(r => r.status === "queued").map(r => r.id));
  return all.filter(b => b.status === "pending" && live.has(b.sid) && (k.role !== "dj" || b.to === k.name));
}
app.post("/api/kj/bump/:id", wrap(async (req, res) => {
  if (!seesBumps(req.kj)) return res.status(403).json({ error: "Only the DJ or the owner can do that." });
  const all = await getBumps(), b = all.find(x => x.id === req.params.id);
  if (!b || b.status !== "pending") return res.status(404).json({ error: "That request is gone." });
  if (req.kj.role === "dj" && b.to !== req.kj.name) return res.status(403).json({ error: "That request went to another DJ." });
  if (!req.body.ok) { b.status = "denied"; b.by = req.kj.name; await saveBumps(all); return res.json({ ok: true }); }
  const act = await db.active(), row = act.find(r => r.id === b.sid);
  if (!row || row.status !== "queued") { b.status = "expired"; await saveBumps(all); return res.status(409).json({ error: b.name + " isn't waiting anymore." }); }
  const now = queuedAhead(act, row) + 1, want = Math.max(1, now - b.spots);
  await placeAt(row.id, want);
  const to = queuedAhead(await db.active(), row) + 1;
  b.status = "approved"; b.by = req.kj.name; b.from = now; b.toSpot = to; await saveBumps(all);
  // count it with the DJ's tips so totals match their payment app
  const night = barDay().date, tips = await getTips(night);
  tips.push({ at: Date.now(), who: row.device, name: b.name, amount: b.amount, method: b.method, comment: "Moved up " + b.spots + (b.spots === 1 ? " spot" : " spots"), to: b.to, bump: b.spots });
  await db.setSetting("tips:" + night, JSON.stringify(tips.slice(-500)));
  const nights = await getTipNights(); if (!nights.includes(night)) { nights.push(night); await db.setSetting("tip_nights", JSON.stringify(nights)); }
  res.json({ ok: true, from: now, to });
}));
// the DJ (or the owner / a manager) sets the price per spot, $1 to $50
app.post("/api/kj/bump-price", wrap(async (req, res) => {
  if (!seesBumps(req.kj)) return res.status(403).json({ error: "Only the DJ or the owner can set the price." });
  const v = parseInt(req.body.price, 10);
  if (!(v >= 1 && v <= 50)) return res.status(400).json({ error: "Pick $1 to $50 a spot." });
  await db.setSetting("bump_price", String(v)); res.json({ ok: true, price: v });
}));
// owner's kill switch, from the live view (owner list PIN)
app.post("/api/watch/bump", wrap(async (req, res) => {
  const t = Date.now(), l = (listTries.get(req.ip) || []).filter(x => t - x < 600000);
  if (l.length >= 10) return res.status(429).json({ error: "Too many tries. Wait 10 minutes." });
  const ok = await pinIs("list", req.headers["x-watch-pin"]);
  if (!ok) { l.push(t); listTries.set(req.ip, l); return res.status(401).json({ error: "Wrong PIN." }); }
  if (req.body.price != null) {
    const v = parseInt(req.body.price, 10); if (!(v >= 1 && v <= 50)) return res.status(400).json({ error: "Pick $1 to $50 a spot." });
    await db.setSetting("bump_price", String(v)); audit("App owner", "owner", "Lock-your-spot price set to $" + v + " a spot");
    if (req.body.on == null) return res.json({ ok: true, price: v });
  }
  await db.setSetting("bump", req.body.on ? "on" : "off");
  if (!req.body.on) { const all = await getBumps(); all.forEach(b => { if (b.status === "pending") { b.status = "canceled"; b.by = "owner turned move-ups off"; } }); await saveBumps(all); }
  res.json({ ok: true, on: !!req.body.on });
}));
// analytics: per night totals + top tipper, tipper ranking, lifetime totals
async function tipStats(days, onlyHost) {
  const nights = await getTipNights(), from = days ? nightOf(Date.now() - days * 864e5) : "";
  let nightsWith = 0;
  const all = [], perNight = [], people = new Map(), hostsT = new Map();
  let life = 0, lifeCount = 0;
  for (const n of nights.sort()) {
    let list = await getTips(n); if (onlyHost) list = list.filter(x => x.to === onlyHost); if (!list.length) continue;
    nightsWith++;
    const sum = list.reduce((a, x) => a + x.amount, 0); life += sum; lifeCount += list.length;
    const inRange = n >= from;
    const byWho = new Map();
    for (const x of list) {
      const w = byWho.get(x.who) || { name: x.name, total: 0 }; w.name = x.name; w.total += x.amount; byWho.set(x.who, w);
      if (inRange) {
        const p = people.get(x.who) || { name: x.name, total: 0, count: 0, nights: new Set(), crowns: 0 };
        p.name = x.name; p.total += x.amount; p.count++; p.nights.add(n); people.set(x.who, p);
        hostsT.set(x.to, (hostsT.get(x.to) || 0) + x.amount); all.push(x);
      }
    }
    if (!inRange) continue;
    const [topWho, top] = [...byWho.entries()].sort((a, b) => b[1].total - a[1].total)[0];
    if (people.has(topWho)) people.get(topWho).crowns++;
    perNight.push({ night: n, total: Math.round(sum * 100) / 100, count: list.length, top: top.name, topAmount: Math.round(top.total * 100) / 100 });
  }
  const r2 = v => Math.round(v * 100) / 100, rangeSum = all.reduce((a, x) => a + x.amount, 0);
  return {
    lifetime: { total: r2(life), count: lifeCount, nights: nightsWith },
    range: { total: r2(rangeSum), count: all.length, avg: all.length ? r2(rangeSum / all.length) : 0, perNight: perNight.length ? r2(rangeSum / perNight.length) : 0 },
    nights: perNight.slice(-30),
    topTippers: [...people.values()].map(p => ({ name: p.name, total: r2(p.total), count: p.count, nights: p.nights.size, crowns: p.crowns })).sort((a, b) => b.total - a.total).slice(0, 15),
    byHost: [...hostsT.entries()].map(([host, total]) => ({ host, total: r2(total) })).sort((a, b) => b.total - a.total)
  };
}

app.post("/api/kj/logout", wrap(async (req, res) => { if (req.kj.role === "dj") await endDj(req.kj.name, null); res.json({ ok: true }); }));
app.post("/api/kj/kick", wrap(async (req, res) => {
  if (req.kj.role === "dj") return res.status(403).json({ error: "Only staff can close a DJ's session." });
  const ds = await endDj(null, (req.kj.role === "staff" ? req.kj.name : "Staff") + " closed your DJ session."); res.json({ ok: true, kicked: ds ? ds.name : null });
}));
// the DJ's phone reports where it is while the console is open; two readings outside the bar closes the session
app.post("/api/kj/where", wrap(async (req, res) => {
  if (req.kj.role !== "dj" || !hasSpot()) return res.json({ ok: true });
  const lat = Number(req.body.lat), lng = Number(req.body.lng), acc = Math.min(Math.max(Number(req.body.acc) || 0, 0), 200);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.json({ ok: true });
  const k = SK("dj:" + req.kj.name);
  if (!djAway({ lat, lng, acc })) { djStrikes.delete(k); return res.json({ ok: true }); }
  const n = (djStrikes.get(k) || 0) + 1; djStrikes.set(k, n);
  if (n < 2) return res.json({ ok: true, warn: true });
  djStrikes.delete(k);
  await endDj(req.kj.name, "You left " + (TEN().short || "the bar") + ", so your DJ session closed.", "left the bar");
  res.status(401).json({ error: "You left " + (TEN().short || "the bar") + ", so your DJ session closed.", kicked: true });
}));
// "Done, next singer" keeps a short undo list for tonight, so a double tap can be put right
async function nextUndo() { try { const u = JSON.parse((await db.getSetting("next_undo")) || "null"); return u && u.night === barDay().date ? u.steps : []; } catch (e) { return []; } }
async function saveUndo(steps) { await db.setSetting("next_undo", JSON.stringify({ night: barDay().date, steps: steps.slice(-10) })); }
app.post("/api/kj/next", wrap(async (req, res) => {
  const list = await db.active();
  const up = list.find(r => r.status === "up"); if (up) await db.setStatus(up.id, "done");
  const nxt = list.find(r => r.status === "queued"); if (nxt) { await db.setStatus(nxt.id, "up"); await markUp(nxt.id); }
  if (up || nxt) { const st = await nextUndo(); st.push({ done: up ? up.id : null, up: nxt ? nxt.id : null }); await saveUndo(st); }
  res.json({ ok: true });
}));
// undo the last "Done, next singer": the singer now up goes back to the front of the line, the one marked done is back up
app.post("/api/kj/undo-next", wrap(async (req, res) => {
  const st = await nextUndo(), last = st.pop();
  if (!last) return res.status(409).json({ error: "Nothing to undo." });
  const cur = (await db.active()).find(r => r.status === "up");
  if (last.up) { const r = await db.get(last.up); if (r && r.status === "up") await db.setStatus(r.id, "queued"); }
  else if (cur) await db.setStatus(cur.id, "queued");
  if (last.done) { const r = await db.get(last.done); if (r && r.status === "done") await db.setStatus(r.id, "up"); }
  await saveUndo(st);
  res.json({ ok: true });
}));
app.post("/api/kj/:id/song", wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10), row = await db.get(id);
  if (!row) return res.status(404).json({ error: "That singer isn't on the list anymore." });
  const song = clean(req.body.song, 80), artist = clean(req.body.artist, 60);
  if (!song) return res.status(400).json({ error: "Enter the song." });
  await db.setSong(id, song, artist); await setNoSong(id, false); await clearRepeat(id); res.json({ ok: true });
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
// put a queued singer at a spot in line (1 = next up)
// paid move-ups are locked in: first paid is first. Nobody (DJ moves, DJ adds, put-backs, or a later
// paid move-up) can land ahead of a paid singer and push them down. A paid singer can still be moved up.
// the DJ can lock a spot by hand (no payment): it works exactly like a paid lock
async function djLock(row, on, who) {
  const all = await getBumps();
  if (on) { if (!all.some(b => b.sid === row.id && b.status === "approved")) all.push({ id: crypto.randomBytes(5).toString("hex"), at: Date.now(), sid: row.id, name: row.name, spots: 0, amount: 0, method: "dj", to: who, status: "approved", by: who, manual: true }); }
  else all.forEach(b => { if (b.sid === row.id && b.status === "approved" && b.manual) { b.status = "unlocked"; b.by = who; } });
  await saveBumps(all);
}
async function paidIds() { return new Set((await getBumps()).filter(b => b.status === "approved").map(b => b.sid)); }
// DJ moves and adds go to any spot, locked or not. Taking a locked singer's spot locks the new singer too,
// so the locked group stays locked (the locked singers behind them each move down one).
async function djPlace(id, spot, kjName) {
  const act = await db.active(), all = act.filter(r => r.status === "queued"), me = all.find(r => r.id === id);
  if (!me) return { locked: false };
  const q = all.filter(r => r.id !== id), i = Math.min(Math.max((parseInt(spot, 10) || q.length + 1) - 1, 0), q.length);
  const paid = await paidIds(), wasLocked = !!(q[i] && paid.has(q[i].id));
  q.splice(i, 0, me);
  for (let k = 0; k < q.length; k++) await db.setPos(q[k].id, k + 1);
  if (wasLocked && !paid.has(id)) { await djLock(me, true, kjName); return { locked: true }; }
  return { locked: false };
}
async function placeAt(id, spot, fresh) {
  // locked spots: a singer who paid keeps their spot number. Anyone moved, added, or paid in ahead of
  // them flows around them (the singer just above slides to just below); a paid spot never changes
  // except moving up as people ahead sing. A paid singer can be moved up, never down.
  const act = await db.active(), all = act.filter(r => r.status === "queued"), me = act.find(r => r.id === id);
  if (!me) return;
  const N = all.length, at = all.findIndex(r => r.id === id), paid = await paidIds();
  if (at < 0) return;
  let i = Math.min(Math.max((parseInt(spot, 10) || N) - 1, 0), N - 1);
  if (paid.has(id) && !fresh) i = Math.min(i, at);
  const pins = new Map(); all.forEach((r, k) => { if (r.id !== id && paid.has(r.id)) pins.set(k, r); });
  // nobody jumps a locked spot: you can't land ahead of a locked singer who is ahead of you
  { const orig = fresh ? N : at; pins.forEach((r, k) => { if (k < orig) i = Math.max(i, k + 1); }); if (orig > 0) i = Math.max(i, 1); i = Math.min(i, N - 1); }   // next up can't be jumped either (only the DJ can)
  while (pins.has(i) && i < N - 1) i++;          // that spot is locked: take the next open one behind it
  while (pins.has(i) && i > 0) i--;
  const out = new Array(N); pins.forEach((r, k) => { out[k] = r; }); out[i] = me;
  const rest = all.filter(r => r.id !== id && !pins.has(all.indexOf(r)));
  for (let k = 0, j = 0; k < N; k++) if (!out[k]) out[k] = rest[j++];
  for (let k = 0; k < N; k++) await db.setPos(out[k].id, k + 1);
}
// DJ/staff add a singer by hand (for guests without the app), optionally at a spot in line
// "Add a singer": find people who have signed up before (name match), newest first, with their last song
app.get("/api/kj/people", wrap(async (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase().slice(0, 30);
  if (q.length < 2) return res.json({ people: [] });
  const rows = await db.history({ q, limit: 300 }), seen = new Map();
  for (const r of rows) { const k = String(r.name || "").toLowerCase(); if (!k.includes(q) || seen.has(k)) continue; seen.set(k, { name: r.name, song: r.song, artist: r.artist || "", at: r.done_at }); if (seen.size >= 8) break; }
  for (const r of await db.active()) { const k = String(r.name || "").toLowerCase(); if (k.includes(q) && !seen.has(k)) seen.set(k, { name: r.name, song: r.song, artist: r.artist || "", inLine: true }); }
  res.json({ people: [...seen.values()].slice(0, 8) });
}));
app.post("/api/kj/add", wrap(async (req, res) => {
  const name = cleanName(req.body.name, 30), song = clean(req.body.song, 80), artist = clean(req.body.artist, 60);
  if (!name) return res.status(400).json({ error: "Enter the singer's name." });
  if (!song) return res.status(400).json({ error: "Enter the song." });
  const row = await db.add({ name, song, artist, device: "kj-" + crypto.randomBytes(6).toString("hex"), via: "dj" });
  let auto = false;
  if (req.body.spot) auto = (await djPlace(row.id, req.body.spot, req.kj.name)).locked;
  if (req.body.lock && !auto) await djLock(row, true, req.kj.name);
  res.json({ ok: true, id: row.id, autoLocked: auto });
}));
app.post("/api/kj/:id/:action", wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10), action = req.params.action, row = await db.get(id);
  if (!row) return res.status(404).json({ error: "That singer isn't on the list anymore." });
  if (action === "lock" || action === "unlock") {
    if (row.status !== "queued") return res.status(400).json({ error: "Only singers waiting in line can be locked." });
    if (action === "unlock" && !(await getBumps()).some(b => b.sid === id && b.status === "approved" && b.manual)) return res.status(409).json({ error: row.name + " paid for this spot, so it stays locked." });
    await djLock(row, action === "lock", req.kj.name); return res.json({ ok: true });
  }
  if (action === "remove") await db.setStatus(id, "removed");
  else if (action === "done") await db.setStatus(id, "done");
  else if (action === "up") {
    const list = await db.active(), cur = list.find(r => r.status === "up");
    if (cur && cur.id !== id) await db.setStatus(cur.id, "queued");
    await db.setStatus(id, "up"); await markUp(id);
  } else if (action === "raise" || action === "lower") {
    const q = (await db.active()).filter(r => r.status === "queued"), i = q.findIndex(r => r.id === id);
    const j = action === "raise" ? i - 1 : i + 1;
    if (i > -1 && j >= 0 && j < q.length) { const r = await djPlace(id, j + 1, req.kj.name); if (r.locked) return res.json({ ok: true, autoLocked: true, note: row.name + " moved into the locked group, so their spot is locked too." }); }
  } else if (action === "repeatok" || action === "repeatno") {
    if (row.status !== "queued") return res.status(400).json({ error: "They're not waiting in line." });
    if (action === "repeatok") { await idSetPut("repeat_ok", id, true); await idSetPut("repeat_ask", id, false); await setNoSong(id, false); }
    else { await idSetPut("repeat_ask", id, true); await setNoSong(id, true); }
  } else if (action === "nosong" || action === "hassong") {
    if (row.status !== "queued" && row.status !== "up") return res.status(400).json({ error: "They're not in line." });
    await setNoSong(id, action === "nosong");
  } else if (action === "readd") {
    // undo an accidental skip: back into line (next up by default)
    if (row.status === "up" || row.status === "queued") return res.status(400).json({ error: "They're already in line." });
    await db.setStatus(id, "queued"); await djPlace(id, req.body.spot || 1, req.kj.name);
  } else if (action === "move") {
    if (row.status !== "queued") return res.status(400).json({ error: "Only singers waiting in line can be moved." });
    const r = await djPlace(id, req.body.spot, req.kj.name);
    if (r.locked) return res.json({ ok: true, autoLocked: true, note: row.name + " took a locked spot, so their spot is locked too." });
  } else return res.status(400).json({ error: "Unknown action." });
  res.json({ ok: true });
}));
app.post("/api/kj-open", kjAuth, auditKj, wrap(async (req, res) => {
  await db.setSetting("open", req.body.open ? "yes" : "no");
  if (req.body.open) { const day = barDay().date; let cur = null; try { cur = JSON.parse((await db.getSetting("open_at")) || "null"); } catch (e) {} if (!cur || cur.night !== day) await db.setSetting("open_at", JSON.stringify({ night: day, at: Date.now() })); }
  res.json({ ok: true });
}));
// Lyrics in Apple Music: find the exact song so the guest lands on it, not on a search page.
// Uses Apple's public iTunes Search API (no key). Cached, and falls back to search if it fails.
const appleSongs = new Map();
app.get("/api/applesong", wrap(async (req, res) => {
  const q = String(req.query.q || "").replace(/\s+/g, " ").trim().slice(0, 140);
  if (!q) return res.json({ url: null });
  if (appleSongs.has(q)) return res.json({ url: appleSongs.get(q) });
  let url = null;
  try {
    const r = await fetch("https://itunes.apple.com/search?media=music&entity=song&limit=1&country=us&term=" + encodeURIComponent(q), { signal: AbortSignal.timeout(3500) });
    if (r.ok) { const j = await r.json(); const t = j && j.results && j.results[0]; if (t && /^https:\/\/music\.apple\.com\//.test(t.trackViewUrl || "")) url = t.trackViewUrl.replace(/[?&]uo=\d+/, ""); }
  } catch (e) {}
  if (appleSongs.size > 3000) appleSongs.clear();
  if (url) appleSongs.set(q, url);
  res.set("Cache-Control", "public, max-age=86400").json({ url });
}));
// song search for the sign-up box: every song Apple Music knows (our own list only has the karaoke favorites)
const songSearchCache = new Map(), songHits = new Map();
// MusicBrainz asks for at most one request a second and a real user agent
let mbNext = 0;
async function mbSearch(query) {
  const wait = mbNext - Date.now(); mbNext = Math.max(Date.now(), mbNext) + 1100;
  if (wait > 4000) return [];
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  try {
    const r = await fetch("https://musicbrainz.org/ws/2/recording?fmt=json&limit=40&query=" + encodeURIComponent(query), { headers: { "User-Agent": "DiveKaraoke/1.0 ( https://the-dive-karaoke.onrender.com )", Accept: "application/json" }, signal: AbortSignal.timeout(4000) });
    if (!r.ok) return [];
    const j = await r.json(), out = [];
    (j.recordings || []).sort((x, y) => (y.score || 0) - (x.score || 0)).forEach(x => {
      const a = (x["artist-credit"] || []).map(c => (c.name || (c.artist && c.artist.name) || "") + (c.joinphrase || "")).join("").trim();
      if (x.title && a && !/\b(karaoke|tribute|made famous|in the style of|instrumental)\b/i.test(x.title + " " + a)) out.push({ t: x.title, a });
    });
    return out;
  } catch (e) { return []; }
}
app.get("/api/songsearch", wrap(async (req, res) => {
  const q = String(req.query.q || "").replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 80);
  const by = req.query.by === "artist", ck = (by ? "a:" : "s:") + q;
  if (q.length < 2) return res.json({ songs: [] });
  if (songSearchCache.has(ck)) return res.json({ songs: songSearchCache.get(ck) });
  const t = Date.now(), l = (songHits.get(req.ip) || []).filter(x => t - x < 60000);
  if (l.length >= 240) return res.json({ songs: [] }); l.push(t); songHits.set(req.ip, l);
  const clean = v => String(v || "").replace(/\s*[\(\[](feat\.?|ft\.?|remaster[^\)\]]*|live[^\)\]]*|radio edit|single version|album version)[^\)\]]*[\)\]]/gi, "").replace(/\s*-\s*(remaster(ed)?|live|single version|radio edit).*$/i, "").trim();
  const out = [], seen = new Set();
  const add = (t, a) => { t = clean(t).slice(0, 80); a = String(a || "").trim().slice(0, 60); const k = (t + "|" + a).toLowerCase(); if (t && a && !seen.has(k)) { seen.add(k); out.push({ t, a }); } };
  // Apple Music's catalog + MusicBrainz (the open music database) for artists who aren't on Apple Music, like Garth Brooks
  const junk = x => /\b(karaoke|tribute|made famous|in the style of|instrumental|originally performed)\b/i.test(x.t + " " + x.a);
  const apple = (async () => {
    try {
      const r = await fetch("https://itunes.apple.com/search?media=music&entity=song&country=us&limit=" + (by ? "50&attribute=artistTerm" : "15") + "&term=" + encodeURIComponent(q), { signal: AbortSignal.timeout(3500) });
      return r.ok ? ((await r.json()).results || []).map(x => ({ t: x.trackName, a: x.artistName })).filter(x => !junk(x)) : [];
    } catch (e) { return []; }
  })();
  const open = mbSearch(by ? 'artist:"' + q.replace(/"/g, "") + '"' : q.replace(/[:"()\[\]{}^~*?\\/!+-]/g, " "));
  const [A, M] = await Promise.all([apple, open]);
  A.slice(0, 5).forEach(x => add(x.t, x.a)); M.slice(0, 15).forEach(x => add(x.t, x.a)); A.slice(5).forEach(x => add(x.t, x.a));
  out.splice(by ? 40 : 10);
  if (songSearchCache.size > 5000) songSearchCache.clear();
  songSearchCache.set(ck, out);
  res.set("Cache-Control", "public, max-age=86400").json({ songs: out });
}));
// the staff list page is owner-only: The Dive uses its own list PIN (STAFF_LIST_PIN in Render, never in code);
// other bars and DJs use their owner PIN
const listTries = new Map();
/* ---------- Bar Owner app (/bar): tips, move-ups, close the DJ's night ----------
   Opens with the bar owner PIN (The Dive: the owner list PIN, never the house PIN) or a manager's own login. */
const barTries = new Map();
async function barAuth(req, res) {
  const t = Date.now(), l = (barTries.get(req.ip) || []).filter(x => t - x < 600000);
  if (l.length >= 10) { res.status(429).json({ error: "Too many tries. Wait 10 minutes." }); return null; }
  const pin = String(req.headers["x-bar-pin"] || "").replace(/\D/g, ""); let nm = ""; try { nm = decodeURIComponent(String(req.headers["x-bar-name"] || "")); } catch (e) {}
  if (pin) {
    if (await pinIs("bar", pin)) {
      const starting = await pinIsStarting("bar");
      if (starting && req.method === "POST" && !/^\/api\/bar\/(pin|phone)$/.test(req.path)) { res.status(403).json({ error: "Set your own Bar Owner PIN first.", needNewPin: true }); return null; }
      return { name: "Owner", owner: true, starting };
    }
    if (T() === "dive" && await pinIs("list", pin)) return { name: "App owner", owner: true };
    const who = await whoIs(pin, nm);
    if (who && who.pick) { res.status(409).json({ error: "Tap your name.", names: who.pick }); return null; }
    if (who && who.manager && who.own) return { name: who.name, manager: true };
  }
  l.push(t); barTries.set(req.ip, l); res.status(401).json({ error: "Wrong PIN. Use the owner PIN or your manager login." }); return null;
}
app.get("/api/bar", wrap(async (req, res) => {
  const who = await barAuth(req, res); if (!who) return;
  if (who.starting) return res.json({ who, mustSetPin: true, ownerPhone: maskPhone(await recoveryPhone("bar")) });
  await djIdleCheck();
  const djNow = await djSession(), s = await tipState(), all = await getTips(barDay().date), act = await db.active(), off = await tipsOff();
  const byDj = {}; all.forEach(x => { byDj[x.to] = Math.round(((byDj[x.to] || 0) + x.amount) * 100) / 100; });
  res.json({
    audit: await auditView(), djLog: await djLogView(), moneyOff: await moneyOff(), who, ownerPhone: who.owner ? maskPhone(await recoveryPhone("bar")) : "",
    dj: djNow ? { name: djNow.name, since: djNow.since || null } : null, tipsStopped: !!(djNow && off && off.name === djNow.name && off.night === barDay().date),
    state: { lyrics: (await db.getSetting("lyrics")) !== "off", multi: (await db.getSetting("multi")) === "on", open: (await db.getSetting("open")) !== "no",
      geofence: geofenceActive(await db.getSetting("geofence")), pause: await pauseState(), queue: await (async () => { const paid = await paidIds(); return (await withPhotosKJ(act.map(kjRow), act)).map(r => paid.has(r.id) ? { ...r, paid: true } : r); })(), done: (await db.done(500)).map(kjRow) },
    moneyOff: await moneyOff(), signups: await signupStats(), phones: await phoneStats(), bump: { on: await bumpOn(), price: await bumpPrice(), list: (await getBumps()).slice().reverse() },
    tips: { on: s.on, host: s.on ? s.host : null, tonight: all.slice().reverse(), byDj, total: Math.round(all.reduce((a, x) => a + x.amount, 0) * 100) / 100 },
    history: await tipStats(30)
  });
}));
app.post("/api/bar/close-dj", wrap(async (req, res) => {
  const who = await barAuth(req, res); if (!who) return;
  const ds = await endDj(null, (who.owner ? "The bar owner" : who.name) + " closed your DJ session."); if (ds) audit(who.name, who.owner ? "bar owner" : "manager", "Closed " + ds.name + "'s DJ night (Bar Owner app)"); res.json({ ok: true, closed: ds ? ds.name : null });
}));
app.post("/api/bar/tips", wrap(async (req, res) => {
  const who = await barAuth(req, res); if (!who) return;
  audit(who.name, who.owner ? "bar owner" : "manager", req.body.on ? "Turned tips back on" : "Stopped tips tonight");
  const ds = await djSession(), s = await tipState();
  if (req.body.on) { await setTipsOff(null); return res.json({ ok: true }); }
  const name = s.on ? s.host : ds ? ds.name : null; if (!name) return res.json({ ok: true });
  if ((await db.getSetting("tip_host")) === name) await db.setSetting("tip_host", "");
  await setTipsOff(name); res.json({ ok: true });
}));
app.post("/api/bar/bump", wrap(async (req, res) => {
  const who = await barAuth(req, res); if (!who) return;
  if (req.body.price != null) {
    const v = parseInt(req.body.price, 10); if (!(v >= 1 && v <= 50)) return res.status(400).json({ error: "Pick $1 to $50 a spot." });
    await db.setSetting("bump_price", String(v)); audit(who.name, who.owner ? "bar owner" : "manager", "Lock-your-spot price set to $" + v + " a spot");
    if (req.body.on == null) return res.json({ ok: true, price: v });
  }
  audit(who.name, who.owner ? "bar owner" : "manager", "Move-ups " + (req.body.on ? "on" : "off"));
  await db.setSetting("bump", req.body.on ? "on" : "off");
  if (!req.body.on) { const all = await getBumps(); all.forEach(b => { if (b.status === "pending") { b.status = "canceled"; b.by = (who.owner ? "owner" : who.name) + " turned move-ups off"; } }); await saveBumps(all); }
  res.json({ ok: true });
}));
// the bar owner changes their own PIN and recovery phone (managers can't)
app.post("/api/bar/pin", wrap(async (req, res) => {
  const who = await barAuth(req, res); if (!who) return;
  if (!who.owner) return res.status(403).json({ error: "Only the bar owner can change this PIN." });
  const pin = String(req.body.pin || "").replace(/\D/g, "");
  if (pin.length < 4 || pin.length > 8) return res.status(400).json({ error: "PIN must be 4 to 8 digits." });
  if (T() === "dive" && pin === startPin("bar")) return res.status(409).json({ error: "That's the starting PIN. Pick your own." });
  if (T() !== "dive" && TEN().pinHash && pinMatches(pin, TEN().pinHash)) return res.status(409).json({ error: "That's your bar's account PIN. Pick a different one for the Bar Owner app." });
  if (pin === TEMP_PIN || (await getHosts()).some(h => h.pin === pin)) return res.status(409).json({ error: "That PIN is taken. Pick another." });
  await setOwnerPin("bar", pin); audit(who.name, "bar owner", "Changed the Bar Owner PIN"); res.json({ ok: true });
}));
async function recoveryPhone(kind) { return (await db.getSetting("recover:" + kind)) || ""; }
const maskPhone = p => p ? "•••-•••-" + p.slice(-4) : "";
app.post("/api/bar/phone", wrap(async (req, res) => {
  const who = await barAuth(req, res); if (!who) return;
  if (!who.owner) return res.status(403).json({ error: "Only the bar owner can set this." });
  const ph = normPhone(req.body.phone); if (!ph) return res.status(400).json({ error: "Enter a 10-digit phone number." });
  await db.setSetting("recover:bar", ph); audit(who.name, "bar owner", "Saved the Bar Owner Forgot-PIN phone"); res.json({ ok: true, phone: maskPhone(ph) });
}));
// app owner list + house PIN recovery phones (set while signed in)
app.post("/api/staff-list/phone", wrap(async (req, res) => {
  if (!(await pinIs("list", req.body.pin))) return res.status(401).json({ error: "Wrong PIN." });
  const ph = normPhone(req.body.phone); if (!ph) return res.status(400).json({ error: "Enter a 10-digit phone number." });
  await db.setSetting("recover:list", ph); audit("App owner", "app owner", "Saved the owner list Forgot-PIN phone"); res.json({ ok: true, phone: maskPhone(ph) });
}));
app.post("/api/staff-list/info", wrap(async (req, res) => {
  if (!(await pinIs("list", req.body.pin))) return res.status(401).json({ error: "Wrong PIN." });
  res.json({ phone: maskPhone(await recoveryPhone("list")) });
}));
/* ---------- Forgot PIN: a code texted to the phone on file, then a new PIN ----------
   kind: house | list | bar | host (a DJ or staff login, by name). Answers the same whether or not the phone matches. */
const forgotHits = new Map();
async function forgotTarget(kind, name) {
  if (PIN_KINDS.includes(kind)) return { phone: await recoveryPhone(kind) };
  if (kind === "host") { const h = (await getHosts()).find(x => x.name.toLowerCase() === String(name || "").trim().toLowerCase()); return h ? { phone: h.phone || "", host: h } : { phone: "" }; }
  return null;
}
app.post("/api/forgot/start", wrap(async (req, res) => {
  if (!TW_READY) return res.status(503).json({ error: "Texting isn't set up. Ask the owner to reset your PIN." });
  const kind = String(req.body.kind || ""), ph = normPhone(req.body.phone);
  if (!ph) return res.status(400).json({ error: "Enter the 10-digit phone number on file." });
  const t = Date.now(), k = kind + "|" + req.ip, l = (forgotHits.get(k) || []).filter(x => t - x < 600000);
  if (l.length >= 3) return res.status(429).json({ error: "Too many tries. Wait 10 minutes." }); l.push(t); forgotHits.set(k, l);
  const tg = await forgotTarget(kind, req.body.name); if (!tg) return res.status(400).json({ error: "Unknown login." });
  if (tg.phone && tg.phone === ph) {
    const r = await twilio("Verifications", { To: ph, Channel: "sms" });
    if (!r.ok) console.error("forgot pin text", r.status, r.body && r.body.message);
  }
  res.json({ ok: true, msg: "If that number is on file, a code is on its way." });
}));
app.post("/api/forgot/finish", wrap(async (req, res) => {
  if (!TW_READY) return res.status(503).json({ error: "Texting isn't set up." });
  const kind = String(req.body.kind || ""), ph = normPhone(req.body.phone), code = String(req.body.code || "").replace(/\D/g, ""), pin = String(req.body.pin || "").replace(/\D/g, "");
  const t = Date.now(), k = "f|" + req.ip, l = (forgotHits.get(k) || []).filter(x => t - x < 600000);
  if (l.length >= 8) return res.status(429).json({ error: "Too many tries. Wait 10 minutes." }); l.push(t); forgotHits.set(k, l);
  if (!ph || code.length < 4) return res.status(400).json({ error: "Enter the code from your text." });
  if (pin.length < 4 || pin.length > 8) return res.status(400).json({ error: "New PIN must be 4 to 8 digits." });
  const tg = await forgotTarget(kind, req.body.name);
  if (!tg || !tg.phone || tg.phone !== ph) return res.status(400).json({ error: "That code didn't work." });
  const r = await twilio("VerificationCheck", { To: ph, Code: code });
  if (!r.ok || r.body.status !== "approved") return res.status(400).json({ error: "That code didn't work. Check it or send a new one." });
  const hosts = await getHosts();
  if (pin === TEMP_PIN || (kind !== "host" && hosts.some(h => h.pin === pin)) || (kind === "host" && (hosts.some(h => h.pin === pin && h.name !== tg.host.name) || await pinIs("house", pin))))
    return res.status(409).json({ error: "That PIN is taken. Pick another." });
  if (kind === "host") { const me = hosts.find(h => h.name === tg.host.name); me.pin = pin; me.own = true; await db.setSetting("hosts", JSON.stringify(hosts)); }
  else await setOwnerPin(kind, pin);
  audit(kind === "host" ? tg.host.name : ({ house: "House PIN", list: "App owner", bar: "Bar owner" })[kind], kind, "Reset a forgotten PIN by text code");
  res.json({ ok: true });
}));
// host page: each login (and the house PIN) can save the phone used for "Forgot PIN"
app.post("/api/kj/my-phone", wrap(async (req, res) => {
  const ph = normPhone(req.body.phone); if (!ph) return res.status(400).json({ error: "Enter a 10-digit phone number." });
  if (req.kj.admin) { await db.setSetting("recover:house", ph); return res.json({ ok: true, phone: maskPhone(ph) }); }
  const hosts = await getHosts(), me = hosts.find(h => h.name === req.kj.name); if (!me) return res.status(404).json({ error: "Login not found." });
  me.phone = ph; await db.setSetting("hosts", JSON.stringify(hosts)); res.json({ ok: true, phone: maskPhone(ph) });
}));
async function auditView() {
  let ns = []; try { ns = JSON.parse((await db.getSetting("audit_nights")) || "[]"); } catch (e) {}
  let out = []; for (const n of ns.slice(-7).reverse()) { out = out.concat((await getAudit(n)).slice().reverse()); if (out.length > 800) break; }
  return out.slice(0, 800);
}
async function djLogView() {
  await djIdleCheck();
  const log = (await getDjLog()).slice().reverse(), ds = await djSession();
  if (ds) { const now = await djNightSummary(ds, Date.now()); now.live = true; now.how = "on now"; now.last = ds.last || ds.since; log.unshift(now); }
  return log.slice(0, 300);
}
// one button (Bar Owner app or the app owner's live view): kill tips and lock-your-spot now, or turn them back on.
// Spots people already paid for stay locked.
async function setMoney(on, who) {
  await db.setSetting("money_off", on ? "" : "on");
  if (!on) { const all = await getBumps(); all.forEach(b => { if (b.status === "pending") { b.status = "canceled"; b.by = who + " turned tips & move-ups off"; } }); await saveBumps(all); }
  else { await setTipsOff(null); await db.setSetting("bump", "on"); }
}
app.post("/api/bar/money", wrap(async (req, res) => { const who = await barAuth(req, res); if (!who) return; await setMoney(!!req.body.on, who.name); audit(who.name, who.owner ? "bar owner" : "manager", req.body.on ? "Turned tips & lock-your-spot back on" : "Killed all tips & lock-your-spot"); res.json({ ok: true, off: !req.body.on }); }));
app.post("/api/watch/money", wrap(async (req, res) => {
  if (!(await pinIs("list", req.headers["x-watch-pin"]))) return res.status(401).json({ error: "Wrong PIN." });
  await setMoney(!!req.body.on, "App owner"); audit("App owner", "app owner", req.body.on ? "Turned tips & lock-your-spot back on" : "Killed all tips & lock-your-spot"); res.json({ ok: true, off: !req.body.on });
}));
// owner's live view (/watch): opens with the owner list PIN, never the house PIN
app.get("/api/watch", wrap(async (req, res) => {
  const t = Date.now(), l = (listTries.get(req.ip) || []).filter(x => t - x < 600000);
  if (l.length >= 10) return res.status(429).json({ error: "Too many tries. Wait 10 minutes." });
  const ok = await pinIs("list", req.headers["x-watch-pin"]);
  if (!ok) { l.push(t); listTries.set(req.ip, l); return res.status(401).json({ error: "Wrong PIN." }); }
  await djIdleCheck();
  const djNow = await djSession(), s = await tipState(), all = await getTips(barDay().date), act = await db.active();
  const byDj = {}; all.forEach(x => { byDj[x.to] = Math.round(((byDj[x.to] || 0) + x.amount) * 100) / 100; });
  res.json({
    state: { djOn: djNow ? djNow.name : null, lyrics: (await db.getSetting("lyrics")) !== "off", multi: (await db.getSetting("multi")) === "on", open: (await db.getSetting("open")) !== "no",
      geofence: geofenceActive(await db.getSetting("geofence")), pause: await pauseState(), queue: await (async () => { const paid = await paidIds(); return (await withPhotosKJ(act.map(kjRow), act)).map(r => paid.has(r.id) ? { ...r, paid: true } : r); })(), done: (await db.done(500)).map(kjRow) },
    audit: await auditView(), djLog: await djLogView(), moneyOff: await moneyOff(), signups: await signupStats(), phones: await phoneStats(), bump: { on: await bumpOn(), price: await bumpPrice(), list: (await getBumps()).slice().reverse() },
    tips: { on: s.on, host: s.on ? s.host : null, tonight: all.slice().reverse(), byDj, total: Math.round(all.reduce((a, x) => a + x.amount, 0) * 100) / 100 }
  });
}));
app.post("/api/staff-list", wrap(async (req, res) => {
  const t = Date.now(), l = (listTries.get(req.ip) || []).filter(x => t - x < 600000);
  if (l.length >= 10) return res.status(429).json({ ok: false, error: "Too many tries. Wait 10 minutes." });
  const ok = await pinIs("list", req.body.pin);
  if (!ok) { l.push(t); listTries.set(req.ip, l); return res.status(401).json({ ok: false, error: "Wrong PIN." }); }
  res.json({ ok: true });
}));
app.post("/api/kj-lyrics", kjAuth, auditKj, wrap(async (req, res) => {
  await db.setSetting("lyrics", req.body.on ? "on" : "off"); res.json({ ok: true });
}));
app.post("/api/kj-multi", kjAuth, auditKj, wrap(async (req, res) => {
  await db.setSetting("multi", req.body.on ? "on" : "off"); res.json({ ok: true });
}));
app.post("/api/kj-geofence", kjAuth, wrap(async (req, res) => {
  res.status(403).json({ error: "The location check is always on. Singers must be at the bar to sign up." });
}));
app.post("/api/kj-photoreview", kjAuth, auditKj, wrap(async (req, res) => {
  await db.setSetting("photo_review", req.body.on ? "on" : "off"); res.json({ ok: true });
}));
app.post("/api/kj-phone", kjAuth, auditKj, wrap(async (req, res) => {
  await db.setSetting("phone_signin", req.body.on ? "on" : "off"); res.json({ ok: true });
}));
app.post("/api/kj-pause", kjAuth, auditKj, wrap(async (req, res) => {
  const m = Number(req.body.minutes);
  await db.setSetting("paused", m === 0 ? "off" : m > 0 ? String(Date.now() + Math.min(m, 240) * 60000) : "on");
  res.json({ ok: true });
}));
app.post("/api/kj-newnight", kjAuth, auditKj, wrap(async (req, res) => {
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
  const stars = r.likes ? "❤️ " + r.likes + (r.likes === 1 ? " like" : " likes") : "";
  const title = `${r.name} sang ${r.song} at The Dive on 495`;
  res.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc((stars ? stars + " · " : "") + "Karaoke night at The Dive on 495, McAllen, TX. Scan to sing!")}">
<meta property="og:image" content="${esc(base)}/logo.png"><meta property="og:url" content="${esc(base)}/s/${r.id}"><meta property="og:type" content="website">
<link rel="icon" href="/logo.png"><style>body{margin:0;background:#0a0c0a;color:#eef3ee;font-family:system-ui,-apple-system,sans-serif;display:grid;place-items:center;min-height:100vh;padding:24px;box-sizing:border-box;text-align:center}
img{width:160px;filter:drop-shadow(0 0 20px rgba(57,181,74,.55))}h1{font-family:Georgia,serif;font-size:28px;margin:16px 0 4px}.s{color:#ff6b8a;font-size:24px;font-weight:700;margin-top:6px}p{color:#9fae9f}a{display:inline-block;margin-top:14px;background:#39b54a;color:#041206;font-weight:700;text-decoration:none;padding:12px 22px;border-radius:999px}</style></head>
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
  links: { app: siteUrl(req) + BASE() + "/", kj: siteUrl(req) + BASE() + "/kj", tv: siteUrl(req) + BASE() + "/tv", poster: siteUrl(req) + BASE() + "/poster", staff: siteUrl(req) + BASE() + "/owner" } });
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
      url: siteUrl(req) + "/b/" + t.slug + "/", kj: siteUrl(req) + "/b/" + t.slug + "/kj", bar: siteUrl(req) + "/b/" + t.slug + "/bar" });
  }
  res.json({ bars: out, house: { name: DIVE.name, songs: (counts.dive || {}).songs || 0 }, signup: siteUrl(req) + "/start" });
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
const PAGES = { "/": "index.html", "/kj": "kj.html", "/poster": "poster.html", "/tent": "tent.html", "/terms": "terms.html", "/owner": "staff.html", "/watch": "watch.html", "/bar": "bar.html", "/setup": "setup.html", "/start": "start.html" };
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
// the owner's list lives at /owner; staff, DJs and guests only get the group links the owner sends (/links/dj ...)
const LINK_GROUPS = ["customers", "dj", "staff", "bar"];
app.get("/staff", (req, res) => { const g = String(req.query.for || ""); res.redirect(301, BASE() + (LINK_GROUPS.includes(g) ? "/links/" + g : "/owner")); });
// group pages get their own title + link preview (iMessage etc.), never the owner's name or app
const LINK_META = { customers: ["Karaoke Links", "Sign up to sing, the Wall of Fame, and our terms."], dj: ["DJ Links", "Links and how-to for DJs."], staff: ["Staff Links", "Links and how-to for bar staff."], bar: ["Bar Owner Links", "Tips, move-ups and closing the night, for the bar owner and managers."] };
app.get("/links/:group", (req, res) => {
  const g = req.params.group; if (!LINK_GROUPS.includes(g)) return res.redirect(BASE() + "/");
  const t = TEN(), key = t.slug + "|links/" + g + "|" + (t.v || 0) + "|" + req.get("host");
  let h = pageCache.get(key);
  if (h == null) {
    const [title, desc] = LINK_META[g], short = t.short || t.name || "The Dive", full = esc(short + " " + title), site = siteUrl(req) + BASE();
    h = rawPage("staff.html")
      .replace(/<title>[^<]*<\/title>/, "<title>" + full + "</title>")
      .replace(/<link rel="manifest"[^>]*>\s*/, "").replace(/<link rel="apple-touch-icon"[^>]*>\s*/, '<link rel="apple-touch-icon" href="/apple-touch-icon.png">\n')
      .replace(/<meta name="apple-mobile-web-app-title"[^>]*>/, '<meta name="apple-mobile-web-app-title" content="' + full + '">')
      .replace('<h1 id="pageTitle">Karaoke Owner List</h1>', '<h1 id="pageTitle">' + esc(title) + '</h1>')
      .replace("</head>", '<meta property="og:title" content="' + full + '">\n<meta property="og:description" content="' + esc(desc) + '">\n<meta property="og:image" content="' + site + '/logo.png">\n<meta property="og:url" content="' + site + '/links/' + g + '">\n<meta name="description" content="' + esc(desc) + '">\n</head>');
    if (!t.house) h = brand(h, t, BASE(), req.get("host"));
    pageCache.set(key, h);
  }
  res.type("html").set("Cache-Control", "no-cache").send(h);
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
app.get("/update.js", (req, res) => res.type("application/javascript").set("Cache-Control", "no-cache").sendFile(path.join(__dirname, "update.js")));
app.get("/forgot.js", (req, res) => res.type("application/javascript").set("Cache-Control", "no-cache").sendFile(path.join(__dirname, "forgot.js")));
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
