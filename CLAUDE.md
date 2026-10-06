# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

"No Sweat, No Haze" is a static web app. It ranks ways out of Luzerne (70 Bendemeer Rd) to home, or out to lunch, by time spent outdoors in live rain, haze and heat. It's live at https://linusfoo.github.io/no-sweat-no-haze/ and deployed by pushing `main` to GitHub, which publishes it with Pages (`.nojekyll` is present). The product reasoning (Five Whys interview) is in `Q.md`.

## Commands

```bash
python -m http.server 8000                        # run locally: http://localhost:8000 (must be http, not file://)
npm test                                          # node --test "tests/*.test.js"
node --test tests/score.test.js                   # one file
node --test --test-name-pattern="haze" tests/score.test.js   # tests matching a name
npm run bump                                      # stamp cache-busting ?v= versions; run before every push
```

There's no build step, no bundler, no lint, and no dependencies. It is vanilla ES modules (`"type": "module"`).

## Cache busting (important)

Every relative import (`./geo.js?v=...`), the `<script src="app.js?v=...">` tag in `index.html` and the local data fetches carry a `?v=YYYYMMDDHHMM` stamp written by `scripts/bump-version.js`.

When adding a new module or import, write it with a `?v=` suffix (any value) so the bump script picks it up. Run `npm run bump` before pushing. Without it, browsers mix cached old JS with new HTML, and new UI won't work.

## Architecture

`app.js` is the only stateful module: one `state` object, loading, building options and rendering HTML via template strings. The `lib/` modules are pure helpers it calls.

- **Data flow:**
  1. `lib/api.js` fetches the APIs; each fetch goes through `cached()`, a localStorage cache with a TTL that falls back to stale data on error.
  2. `lib/conditions.js#conditionsAt` reduces the raw payloads to conditions at one lat/lng. It runs once for the office and once for home.
  3. `lib/score.js` turns those conditions into penalty factors and ranks the options.
  4. `app.js` renders the results.
- **APIs (all keyless, CORS-open, called from the browser):**
  - data.gov.sg v2 real-time (forecast, rainfall, PM2.5, PSI, UV, temperature) and v1 taxi availability. data.gov.sg is rate-limited without a key, so `api.js` serialises those calls through a queue and retries a 429 after about 11 s. Don't parallelise them.
  - arrivelah2.busrouter.sg (live bus arrivals) and data.busrouter.sg (stops/services JSON).
  - The Overpass API for OSM restaurants. It uses GET; it is flaky (504s), so it's retried, re-attempted on refresh and cached for a day.
- **Scoring model (`lib/score.js`):**
  - `feelsLike = totalMin + EXTRA_COST_PER_OUTDOOR_MIN × (outOrigin × (pOrigin − 1) + outDest × (pDest − 1))`.
  - `penalty = 1 + rain + haze + heat`. Sensitive mode doubles haze and heat.
  - Every option has `totalMin`, `outOrigin` and `outDest`; options are ranked by feels-like. Origin and destination use their own conditions.
- **Buses (`lib/bus.js`):**
  - `directTrips` finds no-transfer services from stops near A to stops near B using busrouter route arrays. Ride time is estimated from stop-to-stop distance.
  - `reachableStops` does short hops for lunch.
  - `catchableBus` sets a leave time so the user waits indoors and reaches the stop `STOP_BUFFER_MIN` before the bus.
- **Home options:** bus (from `directTrips` plus live arrivals), MRT (static routes in `data/config.json` → `mrtHome`), Grab/taxi (fare and wait estimated from taxi availability), and "wait 30 min" (only when it's raining now and the forecast is dry; see `waitingHelps`).
- **Lunch (`lib/places.js`):** NEA hawker centres (`data/hawkers.json`, bundled) merged with OSM places. OSM food courts within 120 m of a hawker centre are dropped. Price tiers come from `data/prices.json` (hawker = tier 1; otherwise curated brands/names; else "price unknown"). For each place it picks walking or a short bus ride.
- **User prefs** (tab, sensitive, budget, kinds, include-unknown) persist in localStorage via the `pref` helper in `app.js`.

## Copy and tone

The UI copy is deliberately Singaporean and colloquial: "Pai seh, updating…", "Makan", "Lepak indoors", "Not worth it lah", "go under shelter lah please". Alerts escalate in Singlish with severity, e.g. "Quite hot today" → "Wah, very hot sia" → "Alamak, damn hot!", and "Wah, jialat" → "Wah lau … damn jialat" → "Alamak, hazardous haze!".

Keep new strings in this voice, and match the user's exact wording when they give it. There are no emojis in the UI. The alert builders are `hazeMessage`, `rainMessage`, `heatMessage` and `moodPrefix` in `app.js`.

## Config

Office, home (sample: Tanglin View, Prince Charles Crescent) and MRT routes are in `data/config.json`. If home changes, update `mrtHome` too, since the MRT ride times there are static estimates.
