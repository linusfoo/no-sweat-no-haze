# No Sweat, No Haze

**Stay dry, breathe easy.** Live at **https://linusfoo.github.io/no-sweat-no-haze/**

A web app for office workers at CT Hub (2 Kallang Ave). It ranks ways to get home, or out to lunch, by how much time you'll spend **outdoors** in the current rain, haze and heat.

Why it exists: see [Q.md](Q.md) (the product interview, using the Five Whys).

## Run it

```bash
python -m http.server 8000
```

Then open http://localhost:8000. It needs to be served over http, not opened as a file, because it loads JSON files. No build step, no API keys.

## Test it

```bash
npm test
```

## What it shows

- **Conditions:** the 2-hour forecast and live rain at CT Hub and at home, PSI/PM2.5, temperature and UV.
- **Go home:** taxi, MRT and every direct bus, ranked by *feels like* minutes. For buses, it says when to leave so you wait indoors, not at the stop. When it's raining but the forecast is dry, it also offers "wait 30 min".
- **Lunch:** hawker centres plus OpenStreetMap restaurants, cafes, fast food and food courts within 2 km, filtered by budget. For each place it picks walking or a short bus ride.

**Feels like** = door-to-door minutes + 2 × outdoor minutes × (rain + haze + heat penalty) at each end of the trip. In fine weather that's just the travel time. Tick **Haze/heat sensitive** to double the weight of haze, heat and UV.

## Changing it

- Office, home and MRT routes: `data/config.json`. Home is a sample address (Blk 330 Tampines St 32). MRT ride times are typical values; update `mrtHome` if you change home.
- Price tiers for chains: `data/prices.json`. Unlisted places show as "price unknown".
- Scoring weights: `lib/score.js`.

## Files

| File | What |
|---|---|
| `index.html` | Layout and styles |
| `app.js` | Loads data, builds options, renders |
| `lib/api.js` | Fetching and localStorage caching (data.gov.sg is rate-limited without a key) |
| `lib/conditions.js` | Picks the nearest forecast area, rain gauge, region and station |
| `lib/score.js` | Rain/haze/heat penalties and ranking (pure, unit-tested) |
| `lib/bus.js` | Direct buses and short hops from busrouter.sg route data |
| `lib/places.js` | Lunch places, price tiers, walk vs. bus |
| `data/hawkers.json` | NEA hawker centres (bundled snapshot) |

## Data sources (all free, no key)

- data.gov.sg real-time APIs: 2-hour forecast, rainfall, PM2.5, PSI, UV, air temperature, taxi availability
- [arrivelah](https://arrivelah2.busrouter.sg) for live bus arrivals, and [busrouter.sg](https://busrouter.sg) for stops and routes
- OpenStreetMap via the Overpass API, for restaurants (© OpenStreetMap contributors, ODbL). The public server sometimes times out, so the app retries and caches results for a day.
- NEA hawker centres (data.gov.sg)
