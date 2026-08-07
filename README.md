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

1. **Register as a Tesla developer** at [developer.tesla.com](https://developer.tesla.com): create an app, pick scopes `vehicle_device_data` (read) — add `vehicle_cmds` later if you want controls to actually work.
2. Host your public key and complete [partner registration](https://developer.tesla.com/docs/fleet-api/authentication/partner-tokens) for your region.
3. Complete the [third-party OAuth flow](https://developer.tesla.com/docs/fleet-api/authentication/third-party-tokens) with your Tesla account to get an **access token** (and refresh token).
4. In Render → your service → **Environment**, set:
   - `TESLA_TOKEN` — the access token. That's the only required variable: the server auto-discovers your vehicle from your account.
   - `TESLA_VEHICLE_ID` — optional, only if you own multiple Teslas
   - `TESLA_REGION_BASE` — optional; defaults to the North America endpoint
5. Redeploy. The badge flips from **DEMO** to **LIVE**, and the dashboard swaps in Tesla's own render of *your* car — matching your paint color and wheels (from `vehicle_config`).

Add a payment method in the Tesla developer portal — billing is pay-per-use with a $10/month credit that comfortably covers a personal dashboard if you poll gently.

## Roadmap

- Token auto-refresh (refresh-token flow in `server.js`)
- Fleet Telemetry ingestion for real charge-curve and driving history (much cheaper than polling)
- Working commands (lock, climate, charge limit) via the vehicle-command proxy

## Notes

- `mapFleetToApp()` in `server.js` is the single place Fleet API data is shaped for the UI.
- Charge-session and 7-day charts show demo data until telemetry storage exists; live snapshot fields (battery, range, climate, odometer, tires) are real once credentials are set.
