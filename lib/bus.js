// Static bus planning from busrouter.sg data: which services connect two points with no transfer.
import { distM, walkMin } from './geo.js?v=202610060557';

const BUS_M_PER_MIN = 300; // ~18 km/h average including stops
const ROUTE_DETOUR = 1.15; // stop-to-stop straight lines → road distance

const stopLatLng = (stops, code) => [stops[code][1], stops[code][0]];

export function stopsNear(stops, lat, lng, maxM) {
  const out = [];
  for (const code in stops) {
    const d = distM(lat, lng, stops[code][1], stops[code][0]);
    if (d <= maxM) out.push({ code, name: stops[code][2], road: stops[code][3], dist: d });
  }
  return out.sort((a, b) => a.dist - b.dist);
}

// All (service, boarding stop) pairs from near `from` to near `to`, each with the alighting stop
// closest to `to` and static walk/ride times. Arrivals are added later.
export function directTrips(stops, services, from, to, { maxBoardM = 450, maxAlightM = 1200, maxStops = Infinity } = {}) {
  const boardStops = new Map(stopsNear(stops, from.lat, from.lng, maxBoardM).map((s) => [s.code, s]));
  const best = new Map(); // key service|boardCode → trip

  for (const [no, svc] of Object.entries(services)) {
    for (const route of svc.routes) {
      route.forEach((code, i) => {
        const board = boardStops.get(code);
        if (!board) return;
        let along = 0;
        let alight = null;
        for (let j = i + 1; j < route.length && j - i <= maxStops; j++) {
          const prev = route[j - 1];
          const cur = route[j];
          if (!stops[prev] || !stops[cur]) break;
          along += distM(...stopLatLng(stops, prev), ...stopLatLng(stops, cur));
          const d = distM(to.lat, to.lng, ...stopLatLng(stops, cur));
          if (d <= maxAlightM && (!alight || d < alight.dist)) {
            alight = { code: cur, name: stops[cur][2], road: stops[cur][3], dist: d, along, nStops: j - i };
          }
        }
        if (!alight) return;
        const trip = {
          service: no,
          serviceName: svc.name,
          board,
          alight,
          walkTo: walkMin(board.dist),
          walkFrom: walkMin(alight.dist),
          rideMin: (alight.along * ROUTE_DETOUR) / BUS_M_PER_MIN,
        };
        const key = `${no}|${code}`;
        const prevBest = best.get(key);
        if (!prevBest || trip.walkFrom + trip.rideMin < prevBest.walkFrom + prevBest.rideMin) best.set(key, trip);
      });
    }
  }
  return [...best.values()];
}

// For short hops (lunch): every stop reachable within `maxStops` from a stop near `from`,
// keyed by stop code, keeping the trip with the least walking to board.
export function reachableStops(stops, services, from, { maxBoardM = 450, maxStops = 12 } = {}) {
  const boardStops = new Map(stopsNear(stops, from.lat, from.lng, maxBoardM).map((s) => [s.code, s]));
  const reach = new Map();
  for (const [no, svc] of Object.entries(services)) {
    for (const route of svc.routes) {
      route.forEach((code, i) => {
        const board = boardStops.get(code);
        if (!board) return;
        let along = 0;
        for (let j = i + 1; j < route.length && j - i <= maxStops; j++) {
          const prev = route[j - 1];
          const cur = route[j];
          if (!stops[prev] || !stops[cur]) break;
          along += distM(...stopLatLng(stops, prev), ...stopLatLng(stops, cur));
          const trip = {
            service: no,
            board,
            alight: { code: cur, name: stops[cur][2], road: stops[cur][3], lat: stops[cur][1], lng: stops[cur][0], nStops: j - i },
            walkTo: walkMin(board.dist),
            rideMin: (along * ROUTE_DETOUR) / BUS_M_PER_MIN,
          };
          const prevBest = reach.get(cur);
          if (!prevBest || trip.walkTo + trip.rideMin < prevBest.walkTo + prevBest.rideMin) reach.set(cur, trip);
        }
      });
    }
  }
  return reach;
}

// Minutes you plan to be at the stop before the bus, since predictions drift.
export const STOP_BUFFER_MIN = 2;

// Pick the first bus you can still reach on foot. Rather than leaving now and waiting at the
// stop, wait indoors and leave `leaveInMin` from now, arriving STOP_BUFFER_MIN early.
// Returns null if the service has no live arrival you can make.
export function catchableBus(trip, arrivalsByStop) {
  const etas = arrivalsByStop[trip.board.code]?.[trip.service];
  if (!etas || !etas.length) return null;
  const eta = etas.find((m) => m >= trip.walkTo);
  if (eta == null) return null;
  const spare = eta - trip.walkTo;
  return {
    eta,
    waitAtStop: Math.min(spare, STOP_BUFFER_MIN),
    leaveInMin: Math.max(0, spare - STOP_BUFFER_MIN),
  };
}
