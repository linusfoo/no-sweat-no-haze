// Lunch places: NEA hawker centres plus OpenStreetMap restaurants, with curated price tiers.
import { distM, walkMin } from './geo.js?v=202610060556';
import { catchableBus, STOP_BUFFER_MIN } from './bus.js?v=202610060556';

const KIND_LABEL = {
  hawker: 'Hawker centre',
  food_court: 'Food court',
  restaurant: 'Restaurant',
  fast_food: 'Fast food',
  cafe: 'Cafe',
};
export const kindLabel = (k) => KIND_LABEL[k] || k;

// NEA names look like "Bendemeer Road Blk 29 (Bendemeer Market and Food Centre)":
// show the common name and keep the block as detail.
export function hawkerPlaces(hawkers) {
  return hawkers.map((h, i) => {
    const m = h.name.match(/^(.*?)\s*\((.+)\)$/);
    const stalls = h.stalls ? `${h.stalls} cooked-food stalls` : '';
    return {
      id: `hawker/${i}`,
      name: m ? m[2] : h.name,
      kind: 'hawker',
      cuisine: [m ? m[1] : '', stalls].filter(Boolean).join(' · '),
      lat: h.lat,
      lng: h.lng,
    };
  });
}

// Hawker centres are always tier 1. Chains match by OSM brand tag, then by name.
export function priceTier(place, brands) {
  if (place.kind === 'hawker') return { tier: 1, source: 'hawker' };
  const keys = Object.keys(brands);
  const brand = place.brand?.toLowerCase();
  const name = place.name.toLowerCase();
  const key =
    keys.find((k) => k.toLowerCase() === brand) ||
    keys.find((k) => k.toLowerCase() === name) ||
    keys.find((k) => k.length >= 4 && name.startsWith(k.toLowerCase()));
  return key ? { tier: brands[key], source: 'curated' } : { tier: null, source: null };
}

// OSM often maps hawker centres as food courts too; keep the NEA record.
export function mergePlaces(hawkers, osm) {
  const dupes = (p) =>
    p.kind === 'food_court' && hawkers.some((h) => distM(h.lat, h.lng, p.lat, p.lng) < 120);
  return [...hawkers, ...osm.filter((p) => !dupes(p))];
}

const ASSUMED_BUS_WAIT = 5; // when there's no live arrival for that service

// Best way to get from the office to a place: walk, or a short bus ride if one exists.
// reach: Map(stopCode → trip) from reachableStops().
export function lunchOptions(place, office, stops, reach, arrivals) {
  const d = distM(office.lat, office.lng, place.lat, place.lng);
  const walk = walkMin(d);
  const opts = [{ mode: 'walk', label: 'Walk', totalMin: walk, outOrigin: walk, outDest: 0, distM: d }];

  let bestBus = null;
  for (const [code, trip] of reach) {
    const [lng, lat] = stops[code];
    const fromStop = distM(lat, lng, place.lat, place.lng);
    if (fromStop > 350) continue;
    const walkFrom = walkMin(fromStop);
    const live = catchableBus(trip, arrivals);
    const wait = live ? live.eta - trip.walkTo : ASSUMED_BUS_WAIT;
    const opt = {
      mode: 'bus',
      label: `Bus ${trip.service}`,
      trip,
      live,
      totalMin: trip.walkTo + wait + trip.rideMin + walkFrom,
      outOrigin: trip.walkTo + (live ? live.waitAtStop : STOP_BUFFER_MIN),
      outDest: walkFrom,
      distM: d,
    };
    if (!bestBus || opt.outOrigin + opt.outDest < bestBus.outOrigin + bestBus.outDest) bestBus = opt;
  }
  // A bus only counts if it actually saves time outdoors.
  if (bestBus && bestBus.outOrigin + bestBus.outDest < walk - 2) opts.push(bestBus);
  return opts;
}
