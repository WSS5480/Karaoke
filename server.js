const express = require("express");
const path = require("path");
const crypto = require("crypto");
const QRCode = require("qrcode");

const PORT = process.env.PORT || 3000;
const KJ_PIN = process.env.KJ_PIN || "4950";
const BAR_LAT = parseFloat(process.env.BAR_LAT || "26.2183801"), BAR_LNG = parseFloat(process.env.BAR_LNG || "-98.2287714");
const GEOFENCE_M = parseFloat(process.env.GEOFENCE_M || "150");
const QR_TOKEN = process.env.QR_TOKEN || "dive495";
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
if (process.env.DATABASE_URL) {
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === "off" ? false : { rejectUnauthorized: false } });
  db = {
    async init() {
      await pool.query(`CREATE TABLE IF NOT EXISTS signups (
        id SERIAL PRIMARY KEY, name TEXT NOT NULL, song TEXT NOT NULL, artist TEXT DEFAULT '',
        device TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', position DOUBLE PRECISION NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), done_at TIMESTAMPTZ)`);
      await pool.query(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);
      await pool.query(`ALTER TABLE signups ADD COLUMN IF NOT EXISTS rating INT`);
      await pool.query(`ALTER TABLE signups ADD COLUMN IF NOT EXISTS public BOOLEAN NOT NULL DEFAULT false`);
    },
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
    res.setHeader("Set-Cookie", `dive_device=${d}; Path=/; Max-Age=2592000; SameSite=Lax; HttpOnly${req.secure ? "; Secure" : ""}`);
  }
  return d;
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
  const d = device(req, res);
  const list = await db.active();
  const open = (await db.getSetting("open")) !== "no";
  const mine = list.find(r => r.device === d);
  const last = mine ? null : await db.lastSung(d);
  const geofence = (await db.getSetting("geofence")) !== "off";
  res.json({ open, geofence, queue: list.map(publicRow), mine: mine ? { ...publicRow(mine), spot: list.indexOf(mine) } : null,
    last: last ? { ...publicRow(last), rating: last.rating, public: !!last.public } : null });
}));

app.post("/api/signup", wrap(async (req, res) => {
  const d = device(req, res);
  if ((await db.getSetting("open")) === "no") return res.status(403).json({ error: "Sign-ups are closed for tonight." });
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
  const d = device(req, res), mine = await db.byDevice(d);
  if (!mine) return res.status(404).json({ error: "You're not on the list right now." });
  await db.setStatus(mine.id, "removed");
  res.json({ ok: true });
}));

app.post("/api/rate", wrap(async (req, res) => {
  const d = device(req, res);
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
  const d = device(req, res);
  res.json({ items: (await db.mineAll(d, req.query.sort === "top" ? "top" : "new")).map(histRow) });
}));
app.get("/api/wall", wrap(async (req, res) => {
  res.json({ items: (await db.history({ onlyPublic: true, sort: req.query.sort === "top" ? "top" : "new", limit: 100 })).map(histRow) });
}));

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

db.init().then(() => app.listen(PORT, () => console.log(`Dive sign-up running on port ${PORT}`)));
