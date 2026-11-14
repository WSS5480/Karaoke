# HANDOFF: The Dive karaoke app + website

Start here if you are a new AI session picking this up. Update this file in the same commit as every change.

## How Steve works
- Owner of The Dive on 495 (McAllen, TX). Karaoke ~30 nights a month; the app is LIVE every night. Test before shipping, never break a live night.
- Messages are short, often voice-typed from his phone mid-night. Reply terse, with the reason. Wrapped cards, not sideways tables. Values to copy go in their own copy box.
- End every karaoke reply with: open to-dos, The Dive links (singer app, website, menu admin, owner list, bar owner) with the PINs he uses, and the KJ Total Package App links (suspended, code on GitHub).
- Summary numbers/tiles should drill down to the detail behind them, with a back button.
- Never put PINs, keys or secrets in this repo.

## The app
- Node/Express `server.js`, Postgres via `DATABASE_URL` (in-memory when unset). Settings are a key/value store (`db.getSetting/setSetting`).
- Four apps with a switcher: `/site` Website, `/` Singer app, `/owner` Owner app (owner.html: tabs Tonight=/watch, Money=/bar, Analytics=/stats, Singers=/history, Karaoke & DJs=/kj, Website=/menu-admin, Settings=/setup, Links=/owner/links), `/manager` Store Manager app (manager.html: Karaoke=/kj, Website menu, TV). The shells load the existing pages in an iframe and hand them the PIN through sessionStorage. Staff phones get Owner/Manager switch buttons (localStorage `dive_role`); guests never see them.
- Pages: `/` singer app (index.html), `/kj` DJ page, `/owner/links` old owner list (staff.html), `/bar` bar owner, `/watch` live view, `/stats` analytics, `/history`, `/wall`, `/tv`, `/site` public website (site.html), `/menu-admin` (menuadmin.html).
- Identity is the PHONE: each signup row has `device` (raw device id, or `c<uid>` for a signed-in customer). Likes, posts, wall, duets hang off the signup row. Singer # = settings `singernum:<key>` / `singerby:<num>`.
- `update.js` auto-reloads phones on new builds. `install.js` = Add-to-Home-Screen guide.

## Ship
- Repo WSS5480/Karaoke (local folder tesla-my-tesla). Push `main` and `main:multi-bar`.
- Render service the-dive-karaoke (srv-dauurac1nsns73fqnmcg, workspace Karaoke, now Hobby plan; server + DB are paid, never downgrade). Deploy: trigger a deploy after pushing.
- Local test: `PORT=4012 node server.js` (in-memory; `KJ_PIN=1111 GEOFENCE=off` for scripted tests), Playwright via `NODE_PATH=$(npm root -g)`. Kill with `fuser -k 4012/tcp`.

## Change log (newest first)
- 2026-11-14 KJ page: "Copy song" button on every waiting singer and "📋 Copy song" on the singer up now. Copies "Song Artist" for pasting into the karaoke software's search.
- 2026-11-13 Four-app cleanup: Owner app (/owner, owner PIN) and Store Manager app (/manager) with tabs; switcher bar. New login type "Store manager" (owner adds it on the KJ page next to DJs): runs karaoke and the website menu, sees no money, analytics or logins. /api/kj/whoami added.
- 2026-11-13 Fix a singer's name (KJ page card): rename a phone everywhere, or move ticked songs to another singer # (likes/posts move with songs; tips don't). Two-tap confirm, logged in setting `namefix:log`, one-tap Undo. Singer app: "Wrong name? Ask the DJ."
- 2026-11-09 Logo never cropped; "(must be at The Dive)" on website sign-up buttons; likes limit 150/min with no pop-up; "Add to my phone" button; link previews use og.png; menu admin with AI menu reading (needs ANTHROPIC_API_KEY in Render).
- 2026-11-08 Public website at /site wired to live karaoke data; "Menu, hours & more" button on singer app.

## Decisions
- 2026-11-13 Store managers see no money (tips, move-ups) and no all-time analytics; only the owner does. Owner/Manager buttons show only on staff phones.
- 2026-11-13 Singers can't rename themselves (stops impersonation); only owner/DJs fix names. Reason: protect history and likes.
- 2026-11-09 DJ may drag a locked singer down; locks only stop move-ups and new sign-ups.
- 2026-11-08 KJ Total Package App is a later build: Render service suspended, code stays on GitHub; stop syncing Dive changes into it.
- 2026-11-08 ACASA workspace is live and must not be touched. Catalog app belongs in MY APPS.

## Open items
- Four-app cleanup stage 2 (optional): rebuild tab contents natively instead of iframes; Owner "Tonight" with money tiles like the mockup.
- ANTHROPIC_API_KEY in Render for menu photo reading.
- CATALOG-ETL-BUILD still used? Move active-customer-mapping to MY APPS, delete CATALOG BUILD.
- Twilio: close or park (Steve).
- Website: confirm Instagram handle; Yelp phone fix (Steve).
