# Tesla Monitor

A Tesla-app-style dashboard for monitoring your car, built for the Tesla Fleet API. Dark theme, live charge/climate/location cards, charge-session and driving charts. Runs on realistic demo data out of the box and switches to live data automatically once Fleet API credentials are configured on the server — the token never touches the browser.

## Run locally

```bash
node server.js
# open http://localhost:3000
```

No dependencies. Node 18+.

## Deploy on Render

1. Push this repo to GitHub.
2. In the [Render dashboard](https://dashboard.render.com), click **New → Blueprint**, pick this repo — `render.yaml` sets everything up (free plan).
3. Deploy. The dashboard is live on your `onrender.com` URL, running demo data.

Note: free Render services sleep after inactivity; the first visit after a while takes ~30s to wake.

## Go live with your car

The server has the whole flow built in. One-time setup:

1. Create an app at [developer.tesla.com](https://developer.tesla.com) (origin `https://buddy-ev-monitor.onrender.com`, redirect `https://buddy-ev-monitor.onrender.com/auth/callback`).
2. In Render -> buddy-ev-monitor -> **Environment**, set `TESLA_CLIENT_SECRET` (from your Tesla app's credentials). The Client ID is already in `server.js`.
3. Visit `https://buddy-ev-monitor.onrender.com/setup/register` once - registers your domain with Tesla (the public key at `/.well-known/appspecific/com.tesla.3p.public-key.pem` is served automatically).
4. Visit `https://buddy-ev-monitor.onrender.com/auth/login` and sign in with your Tesla account.
5. The success page shows a **refresh token** - save it in Render as `TESLA_REFRESH_TOKEN` so the link survives restarts.

The badge flips from **DEMO** to **LIVE**, and the dashboard swaps in Tesla's own render of *your* car - matching your paint color and wheels.

Other env vars: `TESLA_VEHICLE_ID` (only if you own multiple Teslas), `TESLA_REGION_BASE` (non-US), `TESLA_TOKEN` (manual access token; legacy). Keep `tesla-private-key.pem` OUT of the repo - it's only needed later for vehicle commands.

Add a payment method in the Tesla developer portal — billing is pay-per-use with a $10/month credit that comfortably covers a personal dashboard if you poll gently.

## Roadmap

- Token auto-refresh (refresh-token flow in `server.js`)
- Fleet Telemetry ingestion for real charge-curve and driving history (much cheaper than polling)
- Working commands (lock, climate, charge limit) via the vehicle-command proxy

## Notes

- `mapFleetToApp()` in `server.js` is the single place Fleet API data is shaped for the UI.
- Charge-session and 7-day charts show demo data until telemetry storage exists; live snapshot fields (battery, range, climate, odometer, tires) are real once credentials are set.
