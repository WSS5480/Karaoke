# The Dive on 495 — karaoke sign-up

Singers scan a QR code, enter their name and song, and see their spot in line. The KJ runs the list from a PIN-protected page.

## Pages
- `/` — singer sign-up and live "up next" list (English and Spanish labels, song search from a 417-song list)
- `/kj` — KJ queue: next singer, sing now, move up/down, remove, open or close sign-ups, start a new night
- `/poster` — printable "Scan to sing" poster with the QR code

## Run on Render
1. Push this folder to a GitHub repo.
2. In Render, create a Postgres database and a Node web service from the repo (build `npm install`, start `npm start`), and set `DATABASE_URL` to the database's internal URL.
3. Set `KJ_PIN` to the PIN your KJ will use. Optional: set `PUBLIC_URL` to your custom domain so the QR code points there.

## Run locally
```
npm install
KJ_PIN=4950 npm start
```
Without `DATABASE_URL` it keeps the list in memory, which is fine for testing.

## Notes
- One active song per phone. A singer cancels to pick a different song.
- Render's free database expires after 30 days unless upgraded; the paid starter plan keeps it.
- The free web service sleeps after 15 minutes idle and takes about a minute to wake on the first scan. A paid instance stays awake.
