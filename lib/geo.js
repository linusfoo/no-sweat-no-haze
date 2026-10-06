// Distance and walking helpers. Short distances only, so equirectangular is accurate enough.
const R = 6371000;
const RAD = Math.PI / 180;

export const WALK_M_PER_MIN = 80; // ~4.8 km/h
export const DETOUR = 1.3; // straight line -> real street path

export function distM(aLat, aLng, bLat, bLng) {
  const x = (bLng - aLng) * RAD * Math.cos(((aLat + bLat) / 2) * RAD);
  const y = (bLat - aLat) * RAD;
  return Math.hypot(x, y) * R;
}

export function walkMin(straightM) {
  return (straightM * DETOUR) / WALK_M_PER_MIN;
}

// Returns { item, dist } for the item closest to (lat, lng).
export function nearest(items, lat, lng, getLatLng) {
  let best = null;
  for (const item of items) {
    const [iLat, iLng] = getLatLng(item);
    const d = distM(lat, lng, iLat, iLng);
    if (!best || d < best.dist) best = { item, dist: d };
  }
  return best;
}
