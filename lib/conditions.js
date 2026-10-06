// Turn raw data.gov.sg payloads into the conditions at one location.
import { distM, nearest } from './geo.js?v=202610060757';

export function forecastAt(fc, lat, lng) {
  if (!fc) return null;
  const area = nearest(fc.area_metadata, lat, lng, (a) => [a.label_location.latitude, a.label_location.longitude]);
  const item = fc.items[0];
  const f = item?.forecasts.find((x) => x.area === area.item.name);
  return f ? { area: f.area, text: f.forecast, period: item.valid_period?.text || '' } : null;
}

// Heaviest 5-minute rainfall among stations within 2 km, else the nearest station.
export function rainAt(rf, lat, lng) {
  if (!rf) return null;
  const values = new Map(rf.readings[0].data.map((r) => [r.stationId, r.value]));
  const withDist = rf.stations
    .filter((s) => values.has(s.id))
    .map((s) => ({ ...s, dist: distM(lat, lng, s.location.latitude, s.location.longitude), mm: values.get(s.id) }))
    .sort((a, b) => a.dist - b.dist);
  if (!withDist.length) return null;
  const close = withDist.filter((s) => s.dist <= 2000);
  const pick = close.length ? close.reduce((a, b) => (b.mm > a.mm ? b : a)) : withDist[0];
  return { mm: pick.mm, station: pick.name, time: rf.readings[0].timestamp };
}

function regionOf(meta, lat, lng) {
  return nearest(meta, lat, lng, (r) => [r.labelLocation.latitude, r.labelLocation.longitude]).item.name;
}

export function pm25At(d, lat, lng) {
  if (!d) return null;
  const region = regionOf(d.regionMetadata, lat, lng);
  return { value: d.items[0].readings.pm25_one_hourly[region], region };
}

export function psiAt(d, lat, lng) {
  if (!d) return null;
  const region = regionOf(d.regionMetadata, lat, lng);
  return { value: d.items[0].readings.psi_twenty_four_hourly[region], region };
}

export function uvNow(d) {
  const idx = d?.records[0]?.index;
  if (!idx?.length) return null;
  const latest = idx.reduce((a, b) => (b.hour > a.hour ? b : a));
  return { value: latest.value, hour: latest.hour };
}

export function tempAt(d, lat, lng) {
  if (!d) return null;
  const values = new Map(d.readings[0].data.map((r) => [r.stationId, r.value]));
  const st = nearest(d.stations.filter((s) => values.has(s.id)), lat, lng, (s) => [s.location.latitude, s.location.longitude]);
  return st ? { value: values.get(st.item.id), station: st.item.name } : null;
}

// Inputs for score.penalty() at one location.
export function conditionsAt(raw, lat, lng) {
  const fc = forecastAt(raw.forecast, lat, lng);
  const rain = rainAt(raw.rainfall, lat, lng);
  const pm = pm25At(raw.pm25, lat, lng);
  const psi = psiAt(raw.psi, lat, lng);
  const uv = uvNow(raw.uv);
  const t = tempAt(raw.temp, lat, lng);
  return {
    fc,
    rain,
    pm,
    psi,
    uv,
    t,
    inputs: {
      forecastText: fc?.text || '',
      rainMm: rain?.mm || 0,
      pm25: pm?.value || 0,
      psi: psi?.value || 0,
      tempC: t?.value || 0,
      uv: uv?.value || 0,
    },
  };
}
