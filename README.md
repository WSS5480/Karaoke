# Karaoke Sign-Up — build guide

Phone-based karaoke sign-up for **The Dive on 495** (McAllen, TX), also sold to other bars and DJs by **Stemo Enterprises LLC** at **$199/month** after a **14-day free trial**.

Guests scan a QR code (or open the link), sign up for a song, and watch their place in line. The host (KJ) runs the line from a PIN-protected page. Everything runs in the phone's browser and can be added to the home screen like an app. There's no App Store.

- **Live site:** https://the-dive-karaoke.onrender.com
- **Code:** https://github.com/WSS5480/Karaoke
- **Hosting:** Render, workspace **"Karaoke"**: web service `the-dive-karaoke` and Postgres database `karaoke-db`
- **Manager office:** My Apps (`my-apps-management` in the **MY APPS** workspace, repo `WSS5480/MY_APPS_MANAGEMENT`)

---

## 1. What it does

### Guests (customer app, `/`)
- Sign up with a name, song and artist, with song and artist suggestions from a 699-song library (188 in Spanish).
- See their spot in line live. The page refreshes itself.
- **Location check:** only phones inside the bar (150 m by default) can sign up. Scanning the QR code always works.
- **Terms pop-up** the first time (Texas-law Terms of Use and Privacy Notice). They must check a box to continue, and the acceptance is recorded.
- **One song in line at a time** unless the host allows more.
- **Rate themselves** (1–5 stars) after singing, and opt in to the **Wall of Fame**.
- **Post to Facebook, Instagram or TikTok** with one icon each. The app makes a branded picture, adds their own photo, or frames their own video, with or without stars. The caption is copied for them, and "Tag The Dive" is checked by default.
- **My Songs** has three tabs:
  - **Ever sang:** every song with date and time, ratings and Share.
  - **♥ Favorites:** tap the heart on any song.
  - **Practice:** their own list, built from the library or typed in.
  - Every song has a one-touch **Sign me up** button.
- **Profile photo** (optional): picked on the phone, sized in a drag/pinch/slider editor (tap the photo to resize it later), cropped square and shrunk to about 30 KB, and stored in the settings table (`photo:<device>`). It shows in the lineup, on the TV and on the wheel's cast lineup. No photo means the bar's logo. Covered in Terms Section 5 (version 2026-10-02).
- **Lyrics:** the Lyrics / Sing along buttons open the song in the guest's own music app (Apple Music, Spotify, YouTube Music, Amazon Music) or a web search. They pick once; it's saved on their phone and can be changed under the Now singing bar. The app never shows lyrics itself.
- **Daily ads** banner from the host.
- **Phone sign-in** with a text code (Twilio). It's optional and can be turned off.
- One profile per phone. The name is locked after the first sign-up, and the host can fix it.

### Host / KJ (`/kj`, PIN)
- Next singer, Sing now, move up or down, Remove, Fix name, History.
- **Singer history pops up** when someone is up: songs, nights, average stars, songs posted, favorite song, recent songs, or "First time!"
- **Posted icons** (f / IG / TT) show on songs the guest shared.
- **Photo check:** guest photos show as thumbnails in the waiting list. Tap one, then **Remove photo** if it's not OK.
- Open or close sign-ups, pause (15 min, 30 min, 1 hour, or until resumed), location check on or off, phone sign-in on or off.
- **Allow more than one song per person** checkbox. It's off by default.
- **Lyrics: on / off** button in Night controls. Off hides every Lyrics / Sing along button and the lyrics pop-ups in the customer app (Now singing still shows).
- Start a new night: clears the line and keeps all history.
- **Separate host logins:** the owner adds hosts, each with their own PIN, and hosts can change their own PIN.
- **Starting PINs:** the owner gives each DJ and staff login a starting PIN. On first sign-in they must make their own PIN before anything else works. A PIN reset puts them back to that step.
- **Host, DJ & Staff Terms:** on first sign-in (and whenever `HOST_TERMS_V` changes) DJs and staff must check a box agreeing to the host terms (terms page, `#hostterms`). Acceptance (version, time, IP) is saved on their login.
- **Tip money:** the house PIN sees every DJ's tips and a per-DJ total (Tips card and Analytics). Each DJ sees only their own. Staff see none.
- **Staff list (`/staff`) is owner-only:** opens with the list PIN (`STAFF_LIST_PIN` in Render; other bars use their owner PIN). Each group (Customers, DJs, House staff) has its own copy button.

### Other pages
| Page | What it's for | PIN |
|---|---|---|
| `/tv` | Cast to a TV: big QR, now singing, up next | – |
| `/wheel` | Spin wheel (songs, drink deals, shots night, challenges), cast mode, QR corner | – |
| `/poster`, `/tent` | Printable QR poster and table tents | – |
| `/wall` | Public Wall of Fame | – |
| `/stats` | Analytics: songs, singers, regulars, busiest hours, top singers, songs and artists | host |
| `/ads` | Make daily ads (headline, picture, days of week, dates) | host |
| `/history` | Customer history with posted icons | host |
| `/staff` | Staff quick list with live links and one-tap copy | – |
| `/terms` | Terms of Use and Privacy Notice | – |
| `/s/:id` | Share card used by the Facebook icon | – |

Every page above can be installed as **its own app** with its own name and icon: Dive KJ, Dive Stats, Dive Wheel, Dive TV and so on. Android installs in one tap. iPhone shows a Share → Add to Home Screen guide, because Apple doesn't allow one-tap installs for websites.

---

## 2. Bars & DJs (the platform)

The Dive stays at the **root links** (`/`, `/kj`…), unchanged. Every other customer gets their own space:

```
https://the-dive-karaoke.onrender.com/b/<their-web-name>/        ← guests
https://the-dive-karaoke.onrender.com/b/<their-web-name>/kj      ← host page
https://the-dive-karaoke.onrender.com/b/<their-web-name>/setup   ← owner settings & billing
```

Every page listed above works under `/b/<name>/` with **their** name, logo, QR code, location, PINs, hosts, ads, wheel, songs and analytics. No customer can see another customer's data.

### Sign-up: `/start`
1. They pick **Bar** or **DJ / KJ business**.
2. They enter a name, web name, city, owner email and street address (bars only).
3. They upload a logo, pick an owner PIN, and can set their location now (optional).
4. They enter a **trial code** from Stemo (optional), or start the **14-day free trial**. No card is needed for the trial.
5. They get their links: customer app, host page, Setup, TV, poster and staff list.

### Owner Setup: `/b/<name>/setup` (owner PIN)
- Plan status (trial days left, paid, ended), **Subscribe $199/month** by card through Stripe, **Manage card or cancel**, and **Apply code**.
- Name, short name, logo, city, address and owner email.
- Facebook, Instagram and TikTok tags for guests' posts.
- Location check: set it from the phone's GPS, choose the radius, or clear it.
- Change the owner PIN.
- **2 host logins** per account.

### DJs
DJs move between venues. On their host page they tap **"📍 I'm at a new venue tonight,"** type the venue name and save. The location check moves to where they're standing, and guests see "Tonight at <venue>."

### When a plan isn't active
Guests see "Karaoke sign-up isn't open right now." Hosts are sent to Setup to subscribe or enter a code. Nothing is deleted.

---

## 3. Manager office (My Apps)

Karaoke shows up in My Apps as the app **"Karaoke Sign-Up"** (code prefix **KAR**).

- **Customers table → Karaoke Sign-Up:** every bar and DJ with plan, hosts ("People"), songs sung, email, city and start date.
  - **Set plan:** pick Paid or Free. Leave days blank for paid with no end date, or put days in for a trial. Karaoke updates right away.
  - **Reset PIN:** type a new owner PIN and tap Reset PIN, for owners who forgot theirs.
  - **Turn off / Turn on:** pause a bar entirely.
  - **open host page ↗**
- **Give someone free time:** choose **Karaoke Sign-Up**, the days and how many, then **Generate codes**. Codes look like `KAR-30D-ABCD-1A2B3C`. Days are **added** to whatever time is left. Each code works once.
- Card subscribers show as **Paid** automatically, because Stripe reports to Karaoke and Karaoke reports to My Apps.

How the two talk to each other:

| From → To | What |
|---|---|
| Karaoke → My Apps `/api/v1/trial` | start a bar's 14-day trial |
| Karaoke → My Apps `/api/v1/redeem-tenant` | apply a code |
| Karaoke → My Apps `/api/v1/plan` | check a bar's plan (every 10 min per bar, in the background) |
| Karaoke → My Apps `/api/v1/tenant-paid` | Stripe subscription on or off |
| My Apps → Karaoke `/api/platform/bars` | list bars for the Customers table |
| My Apps → Karaoke `/api/platform/bars/:slug` | set plan, reset PIN, turn off or on |

Both directions are signed with **the same secret**: My Apps calls it `APP_SECRET_KARAOKE`, and Karaoke calls it `MYAPPS_SECRET`.

---

## 4. Settings (Render environment variables)

### Karaoke service (`the-dive-karaoke`)
| Variable | Needed | What it is |
|---|---|---|
| `DATABASE_URL` | yes | Internal Database URL of `karaoke-db` (starts with `postgresql://`) |
| `KJ_PIN` | yes | The Dive's house PIN (set in Render only; never write it here) |
| `STAFF_LIST_PIN` | no | PIN that opens the owner-only staff list (`/staff`). Falls back to `KJ_PIN`. Set in Render only. |
| `SESSION_SECRET` | no | Signs login cookies. Made automatically and saved if blank. |
| `PUBLIC_URL` | no | Custom domain for QR codes and links, for example `https://karaoke.example.com` |
| `BAR_LAT`, `BAR_LNG`, `GEOFENCE_M` | no | The Dive's location check (defaults: 26.2183801, -98.2287714, 150) |
| `QR_TOKEN` | no | Code in The Dive's QR link that skips the location check (default `dive495`) |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | for phone sign-in | Twilio account. The Verify service "The Dive" is found or created automatically. |
| `TWILIO_VERIFY_SID` | no | Use a specific Verify service (`VA…`) |
| `PHONE_SIGNIN` | no | `off` turns phone sign-in off by default. The host page switch overrides it. |
| `MYAPPS_URL` | for bars/DJs | `https://my-apps-management.onrender.com` |
| `MYAPPS_SLUG` | no | `karaoke` (default) |
| `MYAPPS_SECRET` | for bars/DJs | Same value as `APP_SECRET_KARAOKE` in My Apps |
| `PLATFORM_KEY` | no | Key My Apps uses to read bars. Defaults to `MYAPPS_SECRET`. |
| `STRIPE_SECRET_KEY` | for card payments | Stripe secret key (`sk_live_…`), Stemo Enterprises account |
| `STRIPE_PRICE_ID` | for card payments | Price ID of the $199/month product (`price_…`) |
| `STRIPE_WEBHOOK_SECRET` | for card payments | Signing secret of the webhook below (`whsec_…`) |
| `PRICE_TEXT` | no | Price shown on Setup (default `$199/month`) |

### My Apps service (`my-apps-management`)
| Variable | What it is |
|---|---|
| `KARAOKE_URL` | `https://the-dive-karaoke.onrender.com` |
| `APP_SECRET_KARAOKE` | Long random secret, same as Karaoke's `MYAPPS_SECRET` (16+ characters) |
| `TRIAL_DAYS_KARAOKE` | Optional. Trial length (default 14). |
| `CODE_SECRET` | Already set. Signs all codes. |

### Turning on card payments (Stripe)
1. In Stripe (Stemo Enterprises LLC), create the product **"Karaoke Sign-Up Pro"** with a **$199/month** recurring price, and copy the **Price ID**.
2. Under **Developers → Webhooks**, add the endpoint `https://the-dive-karaoke.onrender.com/api/stripe/webhook` with these events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated` and `customer.subscription.deleted`. Copy the **Signing secret**.
3. Put `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID` and `STRIPE_WEBHOOK_SECRET` on the Karaoke service.
4. Turn on the **Customer portal** in Stripe settings, so "Manage card or cancel" works.

The Stripe connection uses plain HTTPS calls, so no extra npm package is needed.

---

## 5. Deploy

- Render **auto-deploys** the `main` branch of `WSS5480/Karaoke`.
- If a deploy fails with *"could not read Username for github.com"*, Render lost access to the repo. Fix it in GitHub → Settings → Applications → **Installed GitHub Apps** → Render → **Configure** → add **Karaoke**, or reconnect the repo on the Render service's Settings.
- Build: `npm install`. Start: `npm start` (`node server.js`). Node 18 or newer.
- The database tables are created and upgraded automatically on start: `signups`, `settings`, `customers`, `tenants`.
- After changing pages, bump `CACHE` in `sw.js` (for example `dive-v15` → `dive-v16`) so phones pick up the new version.

### New install from scratch
1. Create a Render Postgres database and a Node web service from this repo.
2. Set `DATABASE_URL` (Internal URL) and `KJ_PIN`.
3. Open `/kj`, enter the PIN, open sign-ups and print `/poster`.
4. For bars and DJs, add `MYAPPS_URL` and `MYAPPS_SECRET` here, and `KARAOKE_URL` and `APP_SECRET_KARAOKE` in My Apps.

### Run on your computer
```
npm install
KJ_PIN=1234 npm start          # http://localhost:3000 — keeps data in memory
```
To use a local Postgres: `DATABASE_URL=postgresql://user@localhost/karaoke PGSSL=off KJ_PIN=1234 npm start`.

---

## 6. How it's built (for a developer)

- **One Node/Express server** (`server.js`) plus plain HTML pages. There's no build step or front-end framework.
- **Storage:** Postgres (`pg`), with an in-memory fallback when there's no `DATABASE_URL`.
  - `signups`: every song, with `tenant`, `device`, `status` (queued, up, done, archived, removed), rating, `public`, `posted_to` and times.
  - `settings`: key/value store. The Dive uses plain keys (`open`, `hosts`, `promos`, `profile:<device>`, `terms:<device>`, `lists:<owner>`…). Other customers use the same keys prefixed `t:<slug>:`.
  - `tenants`: one row per bar or DJ (JSON: name, logo as a data URL, location, PIN hash, tags, plan, Stripe info).
  - `customers`: phone sign-in accounts.
- **Multi-bar:**
  - A first middleware reads `/b/<slug>/…`, loads that customer, strips the prefix, and runs the request inside an `AsyncLocalStorage` context (`T()`, `TEN()`, `BASE()`).
  - Every database call filters by `T()` automatically, and The Dive is `dive`.
  - Pages are sent as-is for The Dive. For others, `brand()` rewrites paths to `/b/<slug>/…`, names ("The Dive" → their name), hashtags, social tags, address and storage keys.
  - Logos and app icons come from the uploaded logo.
- **Identity:**
  - `dive_device` cookie (random ID, 1 year).
  - Optional `dive_user` signed cookie after phone sign-in.
  - Host PIN in the `x-kj-pin` header, with 20 wrong tries per 10 minutes allowed.
  - Customer owner PINs are stored as scrypt hashes.
- **Plans:** `planSummary()` treats an account as active when it's paid by Stripe, on a code, on a trial, or set paid in My Apps. Expired trials fall back to inactive.
- **PWA:** `manifest.json`, `kj-manifest.json`, `staff-manifest.json`, `/m/<page>.json`, `sw.js` (network-first, keeps the app shell for weak signal) and `install.js` (install bar on the extra pages).
- **Sharing:** pictures and videos are made on the phone (canvas, MediaRecorder) and shared with the Web Share API. Nothing is uploaded.

### Files
| File | What |
|---|---|
| `server.js` | everything on the server |
| `index.html` | guest app |
| `kj.html` | host page |
| `stats.html`, `ads.html`, `history.html`, `wall.html`, `tv.html`, `wheel.html`, `poster.html`, `tent.html`, `staff.html` | other pages |
| `start.html`, `setup.html` | bar/DJ sign-up and owner settings |
| `terms.html` | Terms of Use and Privacy Notice (version in `TERMS_V` in `server.js`) |
| `songs.json` | song library for suggestions |
| `*-icon-*.png`, `logo.png`, `default-logo.png` | icons and logos |

---

## 7. Every night

1. Open the host page and tap **Open sign-ups**.
2. Location check **on**. DJs tap **I'm at a new venue tonight**.
3. Cast **/tv** (or the wheel) to the TV.
4. Tap **Next singer** as people finish. Use **Pause** for breaks.
5. At close, tap **Start a new night**. History stays saved.

## 8. Problems & fixes

| Problem | Fix |
|---|---|
| "No sign-ups" | Sign-ups are closed or paused, or the location check is blocking. Open sign-ups, or have guests scan the QR code. |
| PIN doesn't work | The Dive: check `KJ_PIN` in Render. Other customers: reset it from My Apps (Reset PIN). |
| Guests can't get text codes | Twilio trial only texts verified numbers. Upgrade Twilio, or turn phone sign-in off on the host page. |
| Data disappeared after a restart | `DATABASE_URL` is missing or wrong, so the app fell back to memory. The log says so. |
| Free database warning | Render's free Postgres expires after 30 days. Upgrade `karaoke-db` to Basic. |
| App slow to open | The free web service sleeps. Upgrade it to Starter. |
| A bar says it's "not active" | Its trial or code ran out. Set its plan in My Apps or send a code. |
| Changes don't show on phones | Close the app fully and reopen it. Bump `CACHE` in `sw.js` on the next deploy. |

## 9. Legal

- Guest **Terms of Use & Privacy Notice** live at `/terms`, with Texas law and Hidalgo County as the venue for The Dive. They're re-branded for other customers. Have an attorney review them.
- Bars and DJs agree to the service terms when they sign up at `/start`. The time and IP are recorded.
- Alcohol deals are for guests 21+ with ID, per TABC. The spin wheel is free to play, with no purchase needed.
