// Exposure scoring. Pure functions, no DOM or network, so they can be unit-tested in node.
//
// Each trip option has outdoor minutes split into the origin end (walk to the stop plus waiting)
// and the destination end (walk from the stop). Conditions at each end give a penalty ≥ 1.
// "Feels like" minutes = total minutes + 2 × outdoor minutes × (penalty − 1),
// so in good weather it's just the travel time, and in rain/haze each minute outside costs more.

export const EXTRA_COST_PER_OUTDOOR_MIN = 2;

// 2-hour forecast text plus observed rainfall (mm in the latest 5-min reading) → 0..3
export function rainFactor(forecastText = '', rainMm = 0) {
  const t = forecastText.toLowerCase();
  let f = 0;
  if (/thunder|heavy/.test(t)) f = 2;
  else if (/light|passing|drizzle/.test(t)) f = 0.8;
  else if (/rain|shower/.test(t)) f = 1.5;
  const observed = rainMm >= 1 ? 2.5 : rainMm > 0 ? 1.5 : 0;
  return Math.min(3, Math.max(f, observed));
}

// NEA bands: PM2.5 1-hr (µg/m³) and 24-hr PSI → 0..2.5, doubled for sensitive people.
export function hazeFactor(pm25 = 0, psi = 0, sensitive = false) {
  const pm = pm25 > 250 ? 2 : pm25 > 150 ? 1 : pm25 > 55 ? 0.5 : 0;
  const ps = psi > 300 ? 2.5 : psi > 200 ? 1.5 : psi > 100 ? 0.6 : psi > 50 ? 0.1 : 0;
  return Math.max(pm, ps) * (sensitive ? 2 : 1);
}

// Air temperature (°C) and UV index → 0..0.8, doubled for sensitive people.
export function heatFactor(tempC = 0, uv = 0, sensitive = false) {
  const t = tempC >= 34 ? 0.4 : tempC >= 32 ? 0.2 : 0;
  const u = uv >= 11 ? 0.4 : uv >= 8 ? 0.25 : uv >= 6 ? 0.1 : 0;
  return (t + u) * (sensitive ? 2 : 1);
}

// Conditions at one place → { rain, haze, heat, total }
export function penalty({ forecastText, rainMm, pm25, psi, tempC, uv }, sensitive = false) {
  const rain = rainFactor(forecastText, rainMm);
  const haze = hazeFactor(pm25, psi, sensitive);
  const heat = heatFactor(tempC, uv, sensitive);
  return { rain, haze, heat, total: 1 + rain + haze + heat };
}

export function comfortLabel(p) {
  if (p.total < 1.3) return 'good';
  if (p.total < 2) return 'meh';
  return 'bad';
}

// option: { totalMin, outOrigin, outDest }
export function feelsLikeMin(option, pOrigin, pDest) {
  const extra =
    option.outOrigin * (pOrigin.total - 1) + option.outDest * (pDest.total - 1);
  return option.totalMin + EXTRA_COST_PER_OUTDOOR_MIN * extra;
}

export function rankOptions(options, pOrigin, pDest) {
  return options
    .map((o) => ({ ...o, feelsLike: feelsLikeMin(o, pOrigin, pDest) }))
    .sort((a, b) => a.feelsLike - b.feelsLike);
}

// Taxi wait estimate from how many free taxis are within 500 m.
export function taxiWaitMin(nearbyTaxis) {
  if (nearbyTaxis >= 10) return 3;
  if (nearbyTaxis >= 4) return 6;
  if (nearbyTaxis >= 1) return 10;
  return 15;
}

// Rough metered fare, excluding surcharges and booking fees.
export function taxiFare(roadKm) {
  return 4.6 + 0.7 * roadKm;
}

// Waiting only helps when it's raining now but the 2-hour forecast isn't rainy (a passing shower).
export function waitingHelps(forecastText, rainMm) {
  return rainMm > 0 && rainFactor(forecastText, 0) < 1;
}
