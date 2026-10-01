const express = require("express");
const path = require("path");
const crypto = require("crypto");
const QRCode = require("qrcode");

const PORT = process.env.PORT || 3000;
const KJ_PIN = process.env.KJ_PIN || "4950";
const BAR_LAT = parseFloat(process.env.BAR_LAT || "26.2183801"), BAR_LNG = parseFloat(process.env.BAR_LNG || "-98.2287714");
const GEOFENCE_M = parseFloat(process.env.GEOFENCE_M || "150");
const QR_TOKEN = process.env.QR_TOKEN || "dive495";
const TW_SID = (process.env.TWILIO_ACCOUNT_SID || "").trim(), TW_TOKEN = (process.env.TWILIO_AUTH_TOKEN || "").trim();
let TW_VERIFY = (process.env.TWILIO_VERIFY_SID || "").trim();
if (!/^VA[0-9a-f]{32}$/i.test(TW_VERIFY)) TW_VERIFY = "";   // blank or not a real Service SID: the app finds or creates one
let AUTH_ON = false;
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
    AUTH_ON = !!TW_VERIFY;
  } catch (e) { console.error("Twilio setup failed:", e.message); }
}
let SESSION_SECRET = process.env.SESSION_SECRET || "";
function metersAway(lat, lng) {
  const R = 6371000, r = x => x * Math.PI / 180, dLat = r(lat - BAR_LAT), dLng = r(lng - BAR_LNG);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(r(BAR_LAT)) * Math.cos(r(lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "20kb" }));

/* ---------- storage: Postgres on Render, memory when run locally ---------- */
let db;
const DB_URL = (process.env.DATABASE_URL || "").trim();
const DB_OK = /^postgres(ql)?:\/\/[^\s]+@[^\s/]+\/\S+$/.test(DB_URL);
if (DB_URL && !DB_OK) console.error(`DATABASE_URL doesn't look like a Postgres link (it should start with postgresql://). It starts with "${DB_URL.slice(0, 8)}" and is ${DB_URL.length} characters. Using in-memory storage until it's fixed.`);
if (DB_OK) {
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: DB_URL, ssl: process.env.PGSSL === "off" ? false : { rejectUnauthorized: false } });
  db = {
    async init() {
      await pool.query(`CREATE TABLE IF NOT EXISTS signups (
        id SERIAL PRIMARY KEY, name TEXT NOT NULL, song TEXT NOT NULL, artist TEXT DEFAULT '',
        device TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', position DOUBLE PRECISION NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), done_at TIMESTAMPTZ)`);
      await pool.query(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);
      await pool.query(`ALTER TABLE signups ADD COLUMN IF NOT EXISTS rating INT`);
      await pool.query(`ALTER TABLE signups ADD COLUMN IF NOT EXISTS public BOOLEAN NOT NULL DEFAULT false`);
      await pool.query(`CREATE TABLE IF NOT EXISTS customers (id SERIAL PRIMARY KEY, phone TEXT UNIQUE NOT NULL, name TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_seen TIMESTAMPTZ)`);
    },
    async customerByPhone(p) { return (await pool.query(`SELECT * FROM customers WHERE phone=$1`, [p])).rows[0]; },
    async customer(id) { return (await pool.query(`SELECT * FROM customers WHERE id=$1`, [id])).rows[0]; },
    async addCustomer(p) { return (await pool.query(`INSERT INTO customers (phone) VALUES ($1) ON CONFLICT (phone) DO UPDATE SET last_seen=now() RETURNING *`, [p])).rows[0]; },
    async setCustomerName(id, n) { await pool.query(`UPDATE customers SET name=$2, last_seen=now() WHERE id=$1`, [id, n]); },
    async moveDevice(from, to) { await pool.query(`UPDATE signups SET device=$2 WHERE device=$1`, [from, to]); },
    async mineAll(d, sort) { return (await pool.query(`SELECT * FROM signups WHERE device=$1 AND done_at IS NOT NULL AND status IN ('done','archived') ORDER BY ${sort === "top" ? "rating DESC NULLS LAST, done_at DESC" : "done_at DESC"} LIMIT 200`, [d])).rows; },
    async lastSung(d) { return (await pool.query(`SELECT * FROM signups WHERE device=$1 AND status IN ('done','archived') AND done_at > now() - interval '12 hours' ORDER BY done_at DESC LIMIT 1`, [d])).rows[0]; },
    async rate(id, rating, pub) { await pool.query(`UPDATE signups SET rating=$2, public=$3 WHERE id=$1`, [id, rating, pub]); },
    async history(o) {
      const where = [`done_at IS NOT NULL`], args = [];
      if (o.onlyPublic) where.push(`public`);
      if (o.q) { args.push('%' + o.q.toLowerCase() + '%'); where.push(`(lower(name) LIKE $${args.length} OR lower(song) LIKE $${args.length} OR lower(artist) LIKE $${args.length})`); }
      args.push(o.limit);
      const order = o.sort === "top" ? `rating DESC NULLS LAST, done_at DESC` : `done_at DESC`;
      return (await pool.query(`SELECT * FROM signups WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT $${args.length}`, args)).rows;
    },
    async active() { return (await pool.query(`SELECT * FROM signups WHERE status IN ('up','queued') ORDER BY (status='up') DESC, position`)).rows; },
    async done(limit) { return (await pool.query(`SELECT * FROM signups WHERE status='done' ORDER BY done_at DESC LIMIT $1`, [limit])).rows; },
    async byDevice(d) { return (await pool.query(`SELECT * FROM signups WHERE device=$1 AND status IN ('up','queued') LIMIT 1`, [d])).rows[0]; },
    async add(r) { return (await pool.query(`INSERT INTO signups (name,song,artist,device,position) VALUES ($1,$2,$3,$4,(SELECT COALESCE(MAX(position),0)+1 FROM signups)) RETURNING *`, [r.name, r.song, r.artist, r.device])).rows[0]; },
    async setStatus(id, s) { await pool.query(`UPDATE signups SET status=$2, done_at=CASE WHEN $2='done' THEN now() ELSE done_at END WHERE id=$1`, [id, s]); },
    async setPos(id, p) { await pool.query(`UPDATE signups SET position=$2 WHERE id=$1`, [id, p]); },
    async get(id) { return (await pool.query(`SELECT * FROM signups WHERE id=$1`, [id])).rows[0]; },
    async newNight() { await pool.query(`UPDATE signups SET status='archived' WHERE status IN ('up','queued','done')`); },
    async getSetting(k) { const r = (await pool.query(`SELECT value FROM settings WHERE key=$1`, [k])).rows[0]; return r ? r.value : null; },
    async setSetting(k, v) { await pool.query(`INSERT INTO settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2`, [k, v]); }
  };
} else {
  console.warn("DATABASE_URL not set: using in-memory storage (data resets on restart).");
  let rows = [], seq = 0, settings = {};
  const now = () => new Date().toISOString();
  db = {
    async init() {},
    customers: [],
    async customerByPhone(p) { return this.customers.find(c => c.phone === p); },
    async customer(id) { return this.customers.find(c => c.id === id); },
    async addCustomer(p) { let c = this.customers.find(x => x.phone === p); if (!c) { c = { id: this.customers.length + 1, phone: p, name: "", created_at: now() }; this.customers.push(c); } return c; },
    async setCustomerName(id, n) { const c = this.customers.find(x => x.id === id); if (c) c.name = n; },
    async moveDevice(from, to) { rows.forEach(r => { if (r.device === from) r.device = to; }); },
    async mineAll(d, sort) { return rows.filter(r => r.device === d && r.done_at && (r.status === "done" || r.status === "archived")).sort(sort === "top" ? (a, b) => (b.rating ?? -1) - (a.rating ?? -1) || b.done_at.localeCompare(a.done_at) : (a, b) => b.done_at.localeCompare(a.done_at)).slice(0, 200); },
    async lastSung(d) { const cut = Date.now() - 12 * 3600e3; return rows.filter(r => r.device === d && (r.status === "done" || r.status === "archived") && r.done_at && Date.parse(r.done_at) > cut).sort((a, b) => b.done_at.localeCompare(a.done_at))[0]; },
    async rate(id, rating, pub) { const r = rows.find(x => x.id === id); if (r) { r.rating = rating; r.public = pub; } },
    async history(o) {
      let l = rows.filter(r => r.done_at && (!o.onlyPublic || r.public));
      if (o.q) { const q = o.q.toLowerCase(); l = l.filter(r => (r.name + " " + r.song + " " + r.artist).toLowerCase().includes(q)); }
      l.sort(o.sort === "top" ? (a, b) => (b.rating ?? -1) - (a.rating ?? -1) || b.done_at.localeCompare(a.done_at) : (a, b) => b.done_at.localeCompare(a.done_at));
      return l.slice(0, o.limit);
    },
    async active() { return rows.filter(r => r.status === "up" || r.status === "queued").sort((a, b) => (b.status === "up") - (a.status === "up") || a.position - b.position); },
    async done(limit) { return rows.filter(r => r.status === "done").sort((a, b) => b.done_at.localeCompare(a.done_at)).slice(0, limit); },
    async byDevice(d) { return rows.find(r => r.device === d && (r.status === "up" || r.status === "queued")); },
    async add(r) { const row = { ...r, id: ++seq, status: "queued", position: Math.max(0, ...rows.map(x => x.position)) + 1, created_at: now(), done_at: null, rating: null, public: false }; rows.push(row); return row; },
    async setStatus(id, s) { const r = rows.find(x => x.id === id); if (r) { r.status = s; if (s === "done") r.done_at = now(); } },
    async setPos(id, p) { const r = rows.find(x => x.id === id); if (r) r.position = p; },
    async get(id) { return rows.find(x => x.id === id); },
    async newNight() { rows.forEach(r => { if (r.status !== "removed") r.status = "archived"; }); },
    async getSetting(k) { return settings[k] ?? null; },
    async setSetting(k, v) { settings[k] = v; }
  };
}

/* ---------- helpers ---------- */
const clean = (s, max) => String(s || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const publicRow = r => ({ id: r.id, name: r.name, song: r.song, artist: r.artist, status: r.status });
function device(req, res) {
  let d = (req.headers.cookie || "").split(/;\s*/).map(c => c.split("=")).find(([k]) => k === "dive_device");
  d = d && /^[a-f0-9]{32}$/.test(d[1]) ? d[1] : null;
  if (!d) {
    d = crypto.randomBytes(16).toString("hex");
    res.append("Set-Cookie", `dive_device=${d}; Path=/; Max-Age=2592000; SameSite=Lax; HttpOnly${req.secure ? "; Secure" : ""}`);
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

/* ---------- singer API ---------- */
app.get("/api/queue", wrap(async (req, res) => {
  const d = owner(req, res);
  const list = await db.active();
  const open = (await db.getSetting("open")) !== "no";
  const mine = list.find(r => r.device === d);
  const last = mine ? null : await db.lastSung(d);
  const geofence = (await db.getSetting("geofence")) !== "off";
  res.json({ open, geofence, queue: list.map(publicRow), mine: mine ? { ...publicRow(mine), spot: list.indexOf(mine) } : null,
    last: last ? { ...publicRow(last), rating: last.rating, public: !!last.public } : null });
}));

app.post("/api/signup", wrap(async (req, res) => {
  const d = owner(req, res);
  if ((await db.getSetting("open")) === "no") return res.status(403).json({ error: "Sign-ups are closed for tonight." });
  if (AUTH_ON && !currentUser(req)) return res.status(401).json({ error: "signin", message: "Sign in with your phone number first." });
  if (rateLimited(req.ip)) return res.status(429).json({ error: "Too many tries. Wait a minute and try again." });
  if ((await db.getSetting("geofence")) !== "off" && req.body.qr !== QR_TOKEN) {
    const lat = Number(req.body.lat), lng = Number(req.body.lng), acc = Math.min(Math.max(Number(req.body.acc) || 0, 0), 200);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(403).json({ error: "location", message: "Turn on location so we can see you're at The Dive, or scan the QR code at the bar." });
    const away = metersAway(lat, lng);
    if (away - acc > GEOFENCE_M) return res.status(403).json({ error: "far", miles: Math.round(away / 1609.34 * 10) / 10, message: "You need to be at The Dive to sign up." });
  }
  const name = clean(req.body.name, 30), song = clean(req.body.song, 80), artist = clean(req.body.artist, 60);
  if (!name) return res.status(400).json({ error: "Enter your name or stage name." });
  if (!song) return res.status(400).json({ error: "Enter the song you want to sing." });
  if (await db.byDevice(d)) return res.status(409).json({ error: "You're already on the list. Cancel your song to pick a different one." });
  const row = await db.add({ name, song, artist, device: d });
  res.json({ ok: true, id: row.id });
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
const histRow = r => ({ id: r.id, name: r.name, song: r.song, artist: r.artist, rating: r.rating, public: !!r.public, at: r.done_at });
app.get("/api/mine", wrap(async (req, res) => {
  const d = owner(req, res);
  res.json({ items: (await db.mineAll(d, req.query.sort === "top" ? "top" : "new")).map(histRow) });
}));
app.get("/api/wall", wrap(async (req, res) => {
  res.json({ items: (await db.history({ onlyPublic: true, sort: req.query.sort === "top" ? "top" : "new", limit: 100 })).map(histRow) });
}));

/* ---------- customer accounts: phone number + text code (Twilio Verify) ---------- */
app.get("/api/me", wrap(async (req, res) => {
  const u = currentUser(req), c = u ? await db.customer(u) : null;
  res.json({ auth: AUTH_ON, user: c ? { name: c.name, phone: "•••-•••-" + c.phone.slice(-4) } : null });
}));
const textHits = new Map();
app.post("/api/auth/start", wrap(async (req, res) => {
  if (!AUTH_ON) return res.status(400).json({ error: "Sign-in isn't set up yet." });
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
  if (!AUTH_ON) return res.status(400).json({ error: "Sign-in isn't set up yet." });
  const phone = normPhone(req.body.phone), code = String(req.body.code || "").replace(/\D/g, "");
  if (!phone || code.length < 4) return res.status(400).json({ error: "Enter the code from your text." });
  const r = await twilio("VerificationCheck", { To: phone, Code: code });
  if (!r.ok || r.body.status !== "approved") return res.status(400).json({ error: "That code didn't work. Check it or send a new one." });
  const c = await db.addCustomer(phone), dev = device(req, res);
  await db.moveDevice(dev, "c" + c.id);
  setUserCookie(req, res, c.id);
  res.json({ ok: true, user: { name: c.name, phone: "•••-•••-" + phone.slice(-4) }, isNew: !c.name });
}));
app.post("/api/auth/name", wrap(async (req, res) => {
  const u = currentUser(req); if (!u) return res.status(401).json({ error: "Sign in first." });
  const n = clean(req.body.name, 30); if (!n) return res.status(400).json({ error: "Enter your name or stage name." });
  await db.setCustomerName(u, n); res.json({ ok: true });
}));
app.post("/api/auth/logout", (req, res) => { res.append("Set-Cookie", "dive_user=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly"); res.json({ ok: true }); });

/* ---------- KJ API (PIN protected) ---------- */
app.use("/api/kj", (req, res, next) => pinOk(req) ? next() : res.status(401).json({ error: "Wrong PIN." }));
app.get("/api/kj/state", wrap(async (req, res) => {
  res.json({ open: (await db.getSetting("open")) !== "no", geofence: (await db.getSetting("geofence")) !== "off", queue: (await db.active()).map(publicRow), done: (await db.done(50)).map(publicRow) });
}));
app.get("/api/kj/history", wrap(async (req, res) => {
  res.json({ items: (await db.history({ sort: req.query.sort === "top" ? "top" : "new", q: clean(req.query.q, 40), limit: 500 })).map(histRow) });
}));
app.post("/api/kj/next", wrap(async (req, res) => {
  const list = await db.active();
  const up = list.find(r => r.status === "up"); if (up) await db.setStatus(up.id, "done");
  const nxt = list.find(r => r.status === "queued"); if (nxt) await db.setStatus(nxt.id, "up");
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
app.post("/api/kj-open", (req, res, next) => pinOk(req) ? next() : res.status(401).json({ error: "Wrong PIN." }), wrap(async (req, res) => {
  await db.setSetting("open", req.body.open ? "yes" : "no"); res.json({ ok: true });
}));
app.post("/api/kj-geofence", (req, res, next) => pinOk(req) ? next() : res.status(401).json({ error: "Wrong PIN." }), wrap(async (req, res) => {
  await db.setSetting("geofence", req.body.on ? "on" : "off"); res.json({ ok: true });
}));
app.post("/api/kj-newnight", (req, res, next) => pinOk(req) ? next() : res.status(401).json({ error: "Wrong PIN." }), wrap(async (req, res) => {
  await db.newNight(); res.json({ ok: true });
}));

/* ---------- QR code ---------- */
app.get("/qr.svg", wrap(async (req, res) => {
  const svg = await QRCode.toString(siteUrl(req) + "/?at=" + QR_TOKEN, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#0a0c0a", light: "#ffffff" } });
  res.type("image/svg+xml").set("Cache-Control", "public, max-age=3600").send(svg);
}));
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
app.get("/s/:id", wrap(async (req, res) => {
  const r = await db.get(parseInt(req.params.id, 10)), base = siteUrl(req);
  if (!r || !r.public) return res.redirect("/wall");
  const stars = r.rating ? "★".repeat(r.rating) + "☆".repeat(5 - r.rating) : "";
  const title = `${r.name} sang ${r.song} at The Dive on 495`;
  res.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc((stars ? stars + " · " : "") + "Karaoke night at The Dive on 495, McAllen, TX. Scan to sing!")}">
<meta property="og:image" content="${esc(base)}/logo.png"><meta property="og:url" content="${esc(base)}/s/${r.id}"><meta property="og:type" content="website">
<link rel="icon" href="/logo.png"><style>body{margin:0;background:#0a0c0a;color:#eef3ee;font-family:system-ui,-apple-system,sans-serif;display:grid;place-items:center;min-height:100vh;padding:24px;box-sizing:border-box;text-align:center}
img{width:160px;filter:drop-shadow(0 0 20px rgba(57,181,74,.55))}h1{font-family:Georgia,serif;font-size:28px;margin:16px 0 4px}.s{color:#5fd36e;font-size:30px;letter-spacing:4px}p{color:#9fae9f}a{display:inline-block;margin-top:14px;background:#39b54a;color:#041206;font-weight:700;text-decoration:none;padding:12px 22px;border-radius:999px}</style></head>
<body><main><img src="/logo.png" alt="The Dive on 495"><h1>${esc(r.name)}</h1><div>sang <b>${esc(r.song)}</b>${r.artist ? " – " + esc(r.artist) : ""}</div><div class="s">${stars}</div>
<p>Karaoke at The Dive on 495 · McAllen, TX</p><a href="/wall">See the wall of fame</a></main></body></html>`);
}));
app.get("/api/url", (req, res) => res.json({ url: siteUrl(req) + "/" }));

const PAGES = { "/": "index.html", "/kj": "kj.html", "/poster": "poster.html", "/tv": "tv.html", "/tent": "tent.html", "/wall": "wall.html", "/history": "history.html", "/logo.png": "logo.png", "/songs.json": "songs.json", "/manifest.json": "manifest.json" };
Object.entries(PAGES).forEach(([route, file]) => app.get(route, (req, res) => res.sendFile(path.join(__dirname, file))));
app.get("/healthz", (req, res) => res.send("ok"));

db.init().then(async () => {
  if (!SESSION_SECRET) { SESSION_SECRET = await db.getSetting("session_secret"); if (!SESSION_SECRET) { SESSION_SECRET = crypto.randomBytes(32).toString("hex"); await db.setSetting("session_secret", SESSION_SECRET); } }
  await setupTwilio();
  console.log(AUTH_ON ? "Phone sign-in: on (Verify service " + TW_VERIFY.slice(0, 6) + "…)" : "Phone sign-in: off (set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN)");
}).then(() => app.listen(PORT, () => console.log(`Dive sign-up running on port ${PORT}`)));
