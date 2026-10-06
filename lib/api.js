// Network access with a small localStorage cache. data.gov.sg rate-limits bursts without an
// API key, so its calls go through a sequential queue and retry once after a 429.

const DG = 'https://api-open.data.gov.sg/v2/real-time/api/';
const BUS_DATA = 'https://data.busrouter.sg/v1/';
const ARRIVELAH = 'https://arrivelah2.busrouter.sg/?id=';
const TAXIS = 'https://api.data.gov.sg/v1/transport/taxi-availability';
const OVERPASS = 'https://overpass-api.de/api/interpreter?data=';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readCache(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeCache(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify({ at: Date.now(), data }));
  } catch {
    // Storage full or blocked: carry on without caching.
  }
}

// Returns { data, at, stale }. On failure it falls back to an expired cached copy if there is one.
async function cached(key, ttlMs, loader) {
  const hit = readCache(key);
  if (hit && Date.now() - hit.at < ttlMs) return { data: hit.data, at: hit.at, stale: false };
  try {
    const data = await loader();
    writeCache(key, data);
    return { data, at: Date.now(), stale: false };
  } catch (err) {
    if (hit) return { data: hit.data, at: hit.at, stale: true };
    throw err;
  }
}

async function fetchJSON(url, { timeoutMs = 20000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) {
      const err = new Error(`${res.status} from ${new URL(url).host}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

let dgQueue = Promise.resolve();

function dataGov(name) {
  const run = async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        const json = await fetchJSON(DG + name);
        if (json.code !== 0) throw new Error(json.errorMsg || `data.gov.sg ${name} failed`);
        return json.data;
      } catch (err) {
        if (err.status === 429 && attempt < 2) {
          await sleep(11000);
          continue;
        }
        throw err;
      }
    }
  };
  const p = dgQueue.then(run, run);
  dgQueue = p.then(() => sleep(400), () => sleep(400));
  return p;
}

const MIN = 60 * 1000;

export const getForecast = () => cached('dg:two-hr-forecast', 10 * MIN, () => dataGov('two-hr-forecast'));
export const getRainfall = () => cached('dg:rainfall', 4 * MIN, () => dataGov('rainfall'));
export const getPm25 = () => cached('dg:pm25', 15 * MIN, () => dataGov('pm25'));
export const getPsi = () => cached('dg:psi', 15 * MIN, () => dataGov('psi'));
export const getUv = () => cached('dg:uv', 15 * MIN, () => dataGov('uv'));
export const getTemperature = () => cached('dg:air-temperature', 5 * MIN, () => dataGov('air-temperature'));

// Free taxi positions as [lat, lng] pairs.
export const getTaxis = () =>
  cached('taxis', 45 * 1000, async () => {
    const json = await fetchJSON(TAXIS);
    const feature = json.features[0];
    return {
      timestamp: feature.properties.timestamp,
      coords: feature.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
    };
  });

// Stops: { code: [lng, lat, name, road] }, services: { no: { name, routes: [[codes...]] } }.
// Too big for localStorage; the browser's HTTP cache (1 day) handles these.
export async function getBusData() {
  const [stops, services] = await Promise.all([
    fetchJSON(BUS_DATA + 'stops.min.json'),
    fetchJSON(BUS_DATA + 'services.min.json'),
  ]);
  return { stops, services };
}

// Live arrivals for one stop: { serviceNo: [minutes until next, subsequent, ...] }
export const getArrivals = (stopCode) =>
  cached(`arr:${stopCode}`, 30 * 1000, async () => {
    const json = await fetchJSON(ARRIVELAH + encodeURIComponent(stopCode));
    const out = {};
    for (const s of json.services || []) {
      out[s.no] = [s.next, s.subsequent, s.next2, s.next3]
        .filter((b) => b && typeof b.duration_ms === 'number')
        .map((b) => Math.max(0, b.duration_ms / 60000))
        .filter((m, i, arr) => arr.indexOf(m) === i);
    }
    return out;
  });

// Restaurants, cafes, fast food and food courts from OpenStreetMap, cached for a day.
export const getOsmPlaces = (lat, lng, radiusM) =>
  cached(`osm:${lat},${lng},${radiusM}`, 24 * 60 * MIN, async () => {
    const sel = `["amenity"~"^(restaurant|cafe|fast_food|food_court)$"](around:${radiusM},${lat},${lng})`;
    const q = `[out:json][timeout:25];(node${sel};way${sel};);out center tags;`;
    // The public Overpass server often answers 504 when busy; a retry usually gets through.
    let json;
    for (let attempt = 0; ; attempt++) {
      try {
        json = await fetchJSON(OVERPASS + encodeURIComponent(q), { timeoutMs: 40000 });
        break;
      } catch (err) {
        const retryable = !err.status || err.status === 429 || err.status >= 500;
        if (!retryable || attempt >= 2) throw err;
        await sleep(4000 * (attempt + 1));
      }
    }
    return json.elements
      .filter((e) => e.tags && e.tags.name)
      .map((e) => ({
        id: `${e.type}/${e.id}`,
        name: e.tags['name:en'] || e.tags.name,
        brand: e.tags.brand || '',
        kind: e.tags.amenity,
        cuisine: (e.tags.cuisine || '').replace(/_/g, ' ').replace(/;/g, ', '),
        lat: e.lat ?? e.center?.lat,
        lng: e.lon ?? e.center?.lon,
      }))
      .filter((p) => p.lat != null && p.lng != null);
  });
