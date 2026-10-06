import * as api from './lib/api.js?v=202610060557';
import { conditionsAt } from './lib/conditions.js?v=202610060557';
import { penalty, rankOptions, feelsLikeMin, EXTRA_COST_PER_OUTDOOR_MIN, rainFactor, hazeFactor, heatFactor, taxiWaitMin, taxiFare, waitingHelps } from './lib/score.js?v=202610060557';
import { directTrips, reachableStops, catchableBus } from './lib/bus.js?v=202610060557';
import { hawkerPlaces, mergePlaces, priceTier, lunchOptions, kindLabel } from './lib/places.js?v=202610060557';
import { distM, walkMin } from './lib/geo.js?v=202610060557';

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const mins = (m) => `${Math.round(m)} min`;
const clock = (d) => d.toLocaleTimeString('en-SG', { hour: 'numeric', minute: '2-digit' });
const inMin = (m) => new Date(Date.now() + m * 60000);

const pref = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem('pref:' + key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem('pref:' + key, JSON.stringify(value));
    } catch {
      // Preferences just won't persist.
    }
  },
};

const KINDS = ['hawker', 'food_court', 'restaurant', 'fast_food', 'cafe'];
const TIER_SIGNS = { 1: '$', 2: '$$', 3: '$$$' };
const BUDGET_LABEL = { 1: 'Below $8', 2: 'Below $15', 3: 'Below $30' };

const state = {
  tab: pref.get('tab', 'home'),
  sensitive: pref.get('sensitive', false),
  budget: pref.get('budget', null),
  includeUnknown: pref.get('unknown', false),
  kinds: new Set(pref.get('kinds', KINDS)),
  cfg: null,
  prices: null,
  hawkers: [],
  raw: {},
  sources: {},
  bus: null,
  trips: [],
  reach: new Map(),
  arrivals: {},
  osm: null,
  osmError: null,
  osmLoading: false,
  refreshing: false,
};

async function loadLocal(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Couldn't load ${path}`);
  return res.json();
}

// ---------- data loading ----------

async function ensureBus() {
  if (state.bus) return;
  try {
    state.bus = await api.getBusData();
    const { stops, services } = state.bus;
    state.trips = directTrips(stops, services, state.cfg.office, state.cfg.home);
    state.reach = reachableStops(stops, services, state.cfg.office);
    state.sources.bus = { at: Date.now() };
  } catch (err) {
    state.sources.bus = { error: err.message };
  }
}

async function loadArrivals() {
  if (!state.bus) return;
  const codes = new Set([...state.trips.map((t) => t.board.code), ...[...state.reach.values()].map((t) => t.board.code)]);
  const results = await Promise.allSettled([...codes].map((c) => api.getArrivals(c).then((r) => [c, r.data])));
  let ok = 0;
  for (const r of results) {
    if (r.status === 'fulfilled') {
      state.arrivals[r.value[0]] = r.value[1];
      ok++;
    }
  }
  state.sources.arrivals = ok ? { at: Date.now() } : { error: 'arrivelah unavailable' };
}

async function loadOsm() {
  if (state.osmLoading) return;
  state.osmLoading = true;
  const { office, lunchRadiusM } = state.cfg;
  try {
    const r = await api.getOsmPlaces(office.lat, office.lng, lunchRadiusM);
    state.osm = r.data;
    state.osmError = null;
    state.sources.osm = { at: r.at, stale: r.stale };
  } catch (err) {
    state.osmError = err.message;
    state.sources.osm = { error: err.message };
  }
  state.osmLoading = false;
  render();
}

async function refresh() {
  if (state.refreshing) return;
  state.refreshing = true;
  $('#status').textContent = 'Pai seh, updating…';
  const live = {
    forecast: api.getForecast,
    rainfall: api.getRainfall,
    pm25: api.getPm25,
    psi: api.getPsi,
    uv: api.getUv,
    temp: api.getTemperature,
    taxis: api.getTaxis,
  };
  const busDone = ensureBus().then(loadArrivals).then(render);
  await Promise.all(
    Object.entries(live).map(async ([key, fn]) => {
      try {
        const r = await fn();
        state.raw[key] = r.data;
        state.sources[key] = { at: r.at, stale: r.stale };
      } catch (err) {
        state.sources[key] = { error: err.message };
      }
      render();
    }),
  );
  await busDone;
  if (!state.osm) loadOsm(); // retry restaurants if an earlier attempt failed
  state.refreshing = false;
  const failed = Object.values(state.sources).filter((s) => s.error).length;
  $('#status').textContent = `Updated ${clock(new Date())}` + (failed ? ` · ${failed} source${failed > 1 ? 's' : ''} unavailable` : '');
}

// ---------- conditions ----------

const level = (x, meh, bad) => (x >= bad ? 'bad' : x >= meh ? 'meh' : 'good');

function psiBand(v) {
  if (v > 300) return 'Hazardous';
  if (v > 200) return 'Very unhealthy';
  if (v > 100) return 'Unhealthy';
  if (v > 50) return 'Moderate';
  return 'Good';
}

function uvBand(v) {
  if (v >= 11) return 'Extreme';
  if (v >= 8) return 'Very high';
  if (v >= 6) return 'High';
  if (v >= 3) return 'Moderate';
  return 'Low';
}

function rainCard(title, c) {
  if (!c.fc && !c.rain) return card(title, 'plain', '—', 'Rain data unavailable');
  const f = rainFactor(c.inputs.forecastText, c.inputs.rainMm);
  const now = c.rain ? (c.rain.mm > 0 ? `Raining now: ${c.rain.mm} mm in 5 min` : 'Dry right now') : 'No rain-gauge reading';
  const period = c.fc ? ` · forecast ${c.fc.period}` : '';
  return card(title, level(f, 0.5, 1.5), esc(c.fc?.text || '—'), `${now}${period}`);
}

function card(title, cls, value, sub) {
  return `<div class="card ${cls}"><div class="k">${esc(title)}</div><div class="v">${value}</div><div class="s">${esc(sub)}</div></div>`;
}

function renderConditions(cO, cD) {
  const { office } = state.cfg;
  const html = [
    rainCard(`${office.name} · ${cO.fc?.area || ''}`, cO),
    rainCard(`Home · ${cD.fc?.area || ''}`, cD),
  ];
  if (cO.psi || cO.pm) {
    const h = hazeFactor(cO.inputs.pm25, cO.inputs.psi, state.sensitive);
    html.push(card('Air quality', level(h, 0.3, 1), `PSI ${cO.psi?.value ?? '—'} · ${psiBand(cO.inputs.psi)}`, `PM2.5 ${cO.pm?.value ?? '—'} µg/m³ (1-hr, ${cO.pm?.region || ''})`));
  } else html.push(card('Air quality', 'plain', '—', 'Air data unavailable'));
  if (cO.t || cO.uv) {
    const h = heatFactor(cO.inputs.tempC, cO.inputs.uv, state.sensitive);
    html.push(card('Heat & UV', level(h, 0.2, 0.5), `${cO.t?.value ?? '—'}°C · UV ${cO.uv?.value ?? '—'}`, `UV ${uvBand(cO.inputs.uv)}${cO.t ? ` · ${cO.t.station}` : ''}`));
  } else html.push(card('Heat & UV', 'plain', '—', 'Heat data unavailable'));
  $('#conditions').innerHTML = html.join('');
}

// ---------- go home ----------

function homeOptions(pO, pD, cO) {
  const { office, home, mrtHome } = state.cfg;
  const opts = [];
  const notRunning = new Set();

  for (const trip of state.trips) {
    const live = catchableBus(trip, state.arrivals);
    if (!live) {
      notRunning.add(trip.service);
      continue;
    }
    opts.push({
      mode: 'bus',
      key: `bus ${trip.service}`,
      label: `Bus ${trip.service}`,
      detail: `${trip.board.name} → ${trip.alight.name} (${trip.alight.nStops} stops)`,
      leaveIn: live.leaveInMin,
      totalMin: live.eta + trip.rideMin + trip.walkFrom,
      outOrigin: trip.walkTo + live.waitAtStop,
      outDest: trip.walkFrom,
      parts: `walk ${mins(trip.walkTo)} + wait ${mins(live.waitAtStop)} · walk ${mins(trip.walkFrom)} at home`,
    });
  }

  for (const m of mrtHome) {
    const walkTo = walkMin(distM(office.lat, office.lng, m.from.lat, m.from.lng));
    const walkFrom = walkMin(distM(m.to.lat, m.to.lng, home.lat, home.lng));
    opts.push({
      mode: 'mrt',
      key: `mrt ${m.from.name}`,
      label: `MRT ${m.line}`,
      detail: `${m.from.name} → ${m.to.name} · ride ~${m.rideMin} min (estimate)`,
      leaveIn: 0,
      totalMin: walkTo + 3 + m.rideMin + walkFrom,
      outOrigin: walkTo,
      outDest: walkFrom,
      parts: `walk ${mins(walkTo)} · walk ${mins(walkFrom)} at home`,
    });
  }

  const taxis = state.raw.taxis;
  if (taxis) {
    const nearby = taxis.coords.filter(([lat, lng]) => distM(office.lat, office.lng, lat, lng) <= 500).length;
    const roadKm = (distM(office.lat, office.lng, home.lat, home.lng) * 1.35) / 1000;
    const wait = taxiWaitMin(nearby);
    const scarce = nearby < 4 && cO.inputs.rainMm > 0 ? ' · rain + few taxis: expect surge' : '';
    opts.push({
      mode: 'taxi',
      key: 'taxi',
      label: 'Grab / taxi',
      detail: `${nearby} free taxis within 500 m · ~$${Math.round(taxiFare(roadKm))} metered${scarce}`,
      leaveIn: 0,
      totalMin: wait + (roadKm * 1000) / 550,
      outOrigin: 1,
      outDest: 1,
      parts: 'book from the lobby · ~1 min each end',
    });
  }

  let ranked = rankOptions(opts, pO, pD);
  // One row per bus service (its best boarding stop).
  const seen = new Set();
  ranked = ranked.filter((o) => (seen.has(o.key) ? false : seen.add(o.key)));

  // A passing shower: compare waiting 30 min indoors, then taking today's best option in drier weather.
  if (cO.fc && waitingHelps(cO.fc.text, cO.inputs.rainMm) && ranked.length) {
    const dryO = penalty({ ...cO.inputs, rainMm: 0 }, state.sensitive);
    const best = rankOptions(opts.filter((o) => o.mode !== 'bus'), dryO, pD)[0] || ranked[0];
    ranked.push({
      mode: 'wait',
      key: 'wait',
      label: 'Wait 30 min',
      detail: `It's raining but the ${cO.fc.period} forecast is "${cO.fc.text}", so it should pass. Then take ${best.label}.`,
      leaveIn: 30,
      totalMin: 30 + best.totalMin,
      outOrigin: best.outOrigin,
      outDest: best.outDest,
      parts: best.parts,
      feelsLike: 30 + feelsLikeMin(best, dryO, pD),
    });
    ranked.sort((a, b) => a.feelsLike - b.feelsLike);
  }
  return { ranked, notRunning: [...notRunning].filter((s) => !ranked.some((o) => o.key === `bus ${s}`)) };
}

// "a, b and c"
const listJoin = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0] || '');

function conditionWords(p) {
  const w = [];
  if (p.rain >= 1.5) w.push('raining');
  else if (p.rain > 0) w.push('drizzly');
  if (p.haze >= 0.5) w.push('hazy');
  if (p.heat >= 0.3) w.push('hot');
  return w;
}

// ---------- alerts and explanations ----------

// The worse the haze, the stronger the Singlish. Bands follow NEA's PSI and PM2.5 levels.
function hazeMessage(psi, pm) {
  const askSwitch = state.sensitive ? '' : ' Got asthma? On the switch below.';
  const band = `PSI ${psi} (${psiBand(psi)}), PM2.5 ${pm} µg/m³`;
  if (psi > 300 || pm > 250) {
    return { level: 'bad', title: 'Alamak, hazardous haze!', text: `${band}. Stay indoors if can. Must go out? Wear N95 and take cab door to door.` };
  }
  if (psi > 200 || pm > 150) {
    return { level: 'bad', title: 'Wah lau, haze damn jialat today', text: `${band}. Don't walk outside unless must. Cab or MRT, and minimise the walk.${askSwitch}` };
  }
  if (psi > 100) {
    return { level: 'bad', title: 'Wah, jialat. Haze is back', text: `${band}. Walk less today, the air not so nice.${askSwitch}` };
  }
  if (pm > 55) {
    return { level: 'meh', title: 'Bit hazy today', text: `${band}. Can still go out, but don't walk too long.${askSwitch}` };
  }
  return null;
}

// Rain: what's falling now (5-min gauge reading) beats the 2-hour forecast.
// 2.5 mm in 5 min is about 30 mm/h, a proper downpour.
function rainMessage(place, c) {
  const home = place === 'home';
  const where = home ? `near home (${c.fc?.area || ''})` : `at ${place}`;
  const mm = c.rain?.mm || 0;
  const thunder = /thunder/i.test(c.fc?.text || '');
  const reading = mm > 0 ? `${mm} mm in the last 5 min at ${c.rain.station}.` : '';
  const walkEnd = home ? ' at the home end' : '';
  if (mm > 0 && thunder) {
    return { level: 'bad', title: `Alamak, thunderstorm ${where}!`, text: `${reading} Lightning also got. Don't walk in the open, wait inside or take cab.` };
  }
  if (mm >= 2.5) {
    return { level: 'bad', title: `Wah lau, raining cats and dogs ${where}`, text: `${reading} Umbrella also no use. Pick the option with the least walking${walkEnd}.` };
  }
  if (mm >= 1) {
    return { level: 'bad', title: `Wah, raining ${where} now sia`, text: `${reading} Don't anyhow walk, options with less walking${walkEnd} go up.` };
  }
  if (mm > 0) {
    return { level: 'meh', title: `Drizzling ${where}`, text: `${reading} Bit wet only, umbrella can settle.` };
  }
  if (!c.fc || rainFactor(c.fc.text, 0) === 0) return null;
  const when = c.fc.period;
  if (thunder || /heavy/i.test(c.fc.text)) {
    return {
      level: 'bad',
      title: `Wah, ${c.fc.text.toLowerCase()} coming ${where}, ${when}`,
      text: home ? 'Now still dry. Better reach home before it pours.' : 'Now still dry. Want to go, go now before it pours.',
    };
  }
  return {
    level: 'meh',
    title: `${c.fc.text} coming ${where}, ${when}`,
    text: home ? 'Now still dry, but bring umbrella or you reach home drenched.' : 'Now still dry. Want to go, better go now.',
  };
}

// Heat: air temperature and UV index, whichever is worse.
function heatMessage(t, uv) {
  const reading = `${t}°C, UV ${uv} (${uvBand(uv)})`;
  if (t >= 35 || uv >= 11) {
    return { level: 'bad', title: `Alamak, damn hot! ${reading}`, text: 'Walk outside sure melt. Stay in the shade, drink water, take MRT or cab.' };
  }
  if (t >= 34 || uv >= 8) {
    return { level: 'bad', title: `Wah, very hot sia: ${reading}`, text: 'Walk 10 min also sure sweat until wet. Short walks and shade win.' };
  }
  if (t >= 33 || uv >= 6) {
    return { level: 'meh', title: `Quite hot today: ${reading}`, text: 'Can walk, but go under shelter where got.' };
  }
  return null;
}

// One exclamation for the worst thing happening at CT Hub right now, to open the recommendation.
function moodPrefix(c) {
  const mm = c.inputs.rainMm;
  if (mm > 0 && /thunder/i.test(c.inputs.forecastText)) return 'Alamak, thunderstorm.';
  if (mm >= 1) return 'Wah, raining sia.';
  if (c.inputs.psi > 100) return 'Wah, the haze jialat.';
  if (c.inputs.tempC >= 34 || c.inputs.uv >= 8) return 'Wah, damn hot today.';
  return '';
}

function buildAlerts(cO, cD) {
  const { office } = state.cfg;
  const alerts = [];
  for (const [place, c] of [[office.name, cO], ['home', cD]]) {
    const a = rainMessage(place, c);
    if (a) alerts.push(a);
  }
  const psi = cO.inputs.psi;
  const pm = cO.inputs.pm25;
  const hazeAlert = hazeMessage(psi, pm);
  if (hazeAlert) {
    alerts.push(hazeAlert);
  } else if (psi > 50 && state.sensitive) {
    alerts.push({ level: 'meh', title: `Air so-so: PSI ${psi}`, text: 'Most people ok. Counted for you because your sensitive switch is on.' });
  }
  const heat = heatMessage(cO.inputs.tempC, cO.inputs.uv);
  if (heat) alerts.push(heat);
  return alerts;
}

function renderAlerts(cO, cD) {
  const loaded = state.raw.forecast || state.raw.psi;
  if (!loaded) {
    $('#alerts').innerHTML = '';
    return;
  }
  const alerts = buildAlerts(cO, cD).sort((a, b) => (a.level === b.level ? 0 : a.level === 'bad' ? -1 : 1));
  $('#alerts').innerHTML = alerts.length
    ? alerts.map((a) => `<div class="alert ${a.level}" role="status"><span class="alert-title">${esc(a.title)}</span> <span class="alert-text">${esc(a.text)}</span></div>`).join('')
    : '<div class="alert good" role="status"><span class="alert-title">Weather steady today</span> <span class="alert-text">No rain, no haze, not too hot. Just take the fastest way.</span></div>';
}

const penaltyMin = (o) => o.feelsLike - o.totalMin;

// Plain-language reason for where an option sits in the ranking.
function explain(o, ctx) {
  const { best, fastest, leastOut, words } = ctx;
  const out = o.outOrigin + o.outDest;
  const weather = words.length ? `the ${listJoin(words.map((w) => ({ raining: 'rain', drizzly: 'drizzle', hazy: 'haze', hot: 'heat' })[w]))}` : 'the weather';
  const tags = [];
  if (o === fastest) tags.push('Fastest');
  if (o === leastOut) tags.push('Least time outside');
  if (o.mode === 'bus' && o.leaveIn >= 1) tags.push(`Lepak indoors ${mins(o.leaveIn)}`);

  if (o.mode === 'wait') return { tags, reason: 'Rain come and go only. Wait it out, then go.', good: o === best };
  if (o === best) {
    let reason;
    if (penaltyMin(best) < 0.5 && !words.length) reason = 'Fastest door to door. Weather ok, no stress.';
    else if (best === fastest && best === leastOut) reason = 'Fastest and hardly outside. Confirm plus chop.';
    else if (best === leastOut) reason = `Only ${mins(out)} outside. ${mins(best.totalMin - fastest.totalMin)} slower than ${fastest.label}, but in ${weather} worth it.`;
    else if (best === fastest) reason = `Fastest, and only ${mins(out)} outside. Shiok.`;
    else reason = `Best of both: ${mins(out)} outside, ${mins(best.totalMin)} door to door.`;
    return { tags, reason, good: true };
  }
  const tripDiff = o.totalMin - best.totalMin;
  const penDiff = penaltyMin(o) - penaltyMin(best);
  let reason;
  if (penDiff > tripDiff && penDiff >= 1) {
    const cause =
      o.outDest >= o.outOrigin
        ? `a ${mins(o.outDest)} walk at the far end`
        : `${mins(o.outOrigin)} walking${o.mode === 'bus' ? ' and waiting' : ''} at the start`;
    reason = `Kena ${cause} in ${weather}. Not worth it lah.`;
  } else if (tripDiff >= 1) {
    reason = `Takes ${mins(tripDiff)} longer door to door. Too slow lah.`;
  } else {
    reason = 'Also can, almost as good.';
  }
  return { tags, reason, good: false };
}

// "Feels like" as a bar: trip time plus the weather penalty for time outside.
function feelsBar(o, maxFeels) {
  const pen = Math.max(0, penaltyMin(o));
  const sev = pen < 2 ? 'good' : pen < 8 ? 'meh' : 'bad';
  const w = (m) => `${Math.max(0, (m / maxFeels) * 100).toFixed(1)}%`;
  const title = `${mins(o.totalMin)} trip + ${mins(pen)} weather penalty`;
  return `<div class="feels"><strong>${mins(o.feelsLike)}</strong>
    <div class="bar" title="${title}" aria-label="${title}"><span class="trip" style="width:${w(o.totalMin)}"></span><span class="pen ${sev}" style="width:${w(pen)}"></span></div>
    ${pen >= 0.5 ? `<div class="sub">+${mins(pen)} weather</div>` : ''}</div>`;
}

function howLine(pO, pD) {
  const perMin = (p) => EXTRA_COST_PER_OUTDOOR_MIN * (p.total - 1);
  const a = perMin(pO);
  const b = perMin(pD);
  if (a < 0.1 && b < 0.1) return 'Ranking: weather is fine, so options are ordered by door-to-door time.';
  const fmt = (x) => (x < 0.1 ? 'nothing' : `${x.toFixed(1)} min`);
  const where = pD === pO ? '' : Math.abs(a - b) < 0.05 ? ' at both ends' : ` at CT Hub and ${fmt(b)} near home`;
  return `Ranking: feels like = door-to-door time + a weather penalty. Right now each minute outside adds ${fmt(a)}${where}.`;
}

function leaveText(o) {
  if (o.mode === 'wait') return 'in 30 min';
  if (o.leaveIn < 0.5) return o.mode === 'bus' ? '<strong>Now</strong>' : 'Now';
  return `in ${mins(o.leaveIn)}`;
}

function outdoorPill(o, pO, pD) {
  const out = o.outOrigin + o.outDest;
  const weighted = o.outOrigin * (pO.total - 1) + o.outDest * (pD.total - 1);
  const cls = out < 4 || weighted < 2 ? 'good' : weighted < 8 ? 'meh' : 'bad';
  return `<span class="pill ${cls}">${mins(out)}</span><div class="sub">${esc(o.parts)}</div>`;
}

function renderHome(pO, pD, cO) {
  const { home } = state.cfg;
  const { ranked, notRunning } = homeOptions(pO, pD, cO);
  if (!ranked.length) {
    $('#home-verdict').innerHTML = `<div class="big">Pai seh, please wait ah…</div>`;
    $('#home-rows').innerHTML = '';
    return;
  }
  const best = ranked[0];
  const words = [...new Set([...conditionWords(pO), ...conditionWords(pD)])];
  const fastest = [...ranked].sort((a, b) => a.totalMin - b.totalMin)[0];
  let why;
  if (!words.length) why = 'Weather ok today, so just take the fastest.';
  else {
    why = `It's ${listJoin(words)} today. This one keeps you outside only ${mins(best.outOrigin + best.outDest)}`;
    if (fastest !== best) why += `, vs ${mins(fastest.outOrigin + fastest.outDest)} for the faster ${fastest.label}`;
    why += '.';
  }
  const mood = moodPrefix(cO);
  if (mood) why = `${mood} ${why}`;
  if (state.sensitive && pO.haze + pO.heat + pD.haze + pD.heat > 0) why += ' Ranked with sensitive mode on.';
  const leave = best.mode === 'wait' ? 'wait 30 min first' : best.leaveIn < 0.5 ? 'go now' : `leave in ${mins(best.leaveIn)}`;
  $('#home-verdict').innerHTML = `<div class="big">${esc(best.label)}: ${leave}, reach home by ${clock(inMin(best.totalMin))}</div><div class="why">${esc(why)}</div><div class="how">${esc(howLine(pO, pD))}</div>`;

  const shown = ranked.slice(0, 8);
  const ctx = {
    best,
    fastest,
    leastOut: [...ranked].sort((a, b) => a.outOrigin + a.outDest - (b.outOrigin + b.outDest))[0],
    words,
  };
  const maxFeels = Math.max(...shown.map((o) => o.feelsLike));
  $('#home-rows').innerHTML = shown
    .map((o, i) => {
      const ex = explain(o, ctx);
      const tags = ex.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('');
      return `<tr class="${i === 0 ? 'best' : ''}">
        <td><div class="mode">${esc(o.label)} ${tags}</div><div class="sub">${esc(o.detail)}</div><div class="reason ${ex.good ? 'up' : 'down'}">${esc(ex.reason)}</div></td>
        <td class="num">${leaveText(o)}</td>
        <td>${outdoorPill(o, pO, pD)}</td>
        <td class="num hide-sm">${mins(o.totalMin)}</td>
        <td class="num">${clock(inMin(o.totalMin))}</td>
        <td class="num">${feelsBar(o, maxFeels)}</td>
      </tr>`;
    })
    .join('');

  const notes = [`To ${home.name.toLowerCase()} (${home.address}). Bus times are live from arrivelah; MRT ride times are typical, not live.`];
  if (notRunning.length) notes.push(`Bus ${notRunning.join(', ')}: none coming that you can catch now.`);
  if (ranked.length > 8) notes.push(`${ranked.length - 8} slower options hidden.`);
  $('#home-note').textContent = notes.join(' ');
}

// ---------- lunch ----------

function renderLunchControls() {
  const tiers = state.prices.tiers;
  $('#budget').innerHTML = Object.keys(tiers)
    .map((t) => `<button class="chip" type="button" data-tier="${t}" aria-pressed="${+t === state.budget}">${BUDGET_LABEL[t]}</button>`)
    .join('');
  $('#kinds').innerHTML = KINDS.map((k) => `<button class="chip" type="button" data-kind="${k}" aria-pressed="${state.kinds.has(k)}">${esc(kindLabel(k))}</button>`).join('');
  $('#unknown').checked = state.includeUnknown;
}

// Why a place uses the bus, or why its walk costs it.
function lunchReason(best) {
  if (best.mode === 'bus') {
    const saved = walkMin(best.distM) - (best.outOrigin + best.outDest);
    return `<div class="reason up">Take bus ${esc(best.trip.service)}, save ${mins(saved)} of walking under the sun.</div>`;
  }
  const pen = penaltyMin(best);
  return pen >= 2 ? `<div class="reason down">${mins(best.outOrigin)} walk. In this weather, feels like ${mins(pen)} more.</div>` : '';
}

function renderLunch(pO) {
  const { office, lunchRadiusM } = state.cfg;
  if (!state.bus) {
    $('#lunch-verdict').innerHTML = '<div class="big">Pai seh, still loading the buses…</div>';
    return;
  }
  const hawkers = hawkerPlaces(state.hawkers).filter((h) => distM(office.lat, office.lng, h.lat, h.lng) <= lunchRadiusM);
  const places = mergePlaces(hawkers, state.osm || []);
  const rows = [];
  for (const place of places) {
    if (!state.kinds.has(place.kind)) continue;
    const price = priceTier(place, state.prices.brands);
    if (price.tier == null ? !state.includeUnknown : price.tier > state.budget) continue;
    const best = rankOptions(lunchOptions(place, office, state.bus.stops, state.reach, state.arrivals), pO, pO)[0];
    rows.push({ place, price, best });
  }
  rows.sort((a, b) => a.best.feelsLike - b.best.feelsLike);

  const budgetText = BUDGET_LABEL[state.budget].toLowerCase();
  if (!rows.length) {
    $('#lunch-verdict').innerHTML = `<div class="big">Alamak, nothing ${esc(budgetText)}</div><div class="why">Try a bigger budget, more place types, or include places with unknown prices.</div>`;
    $('#lunch-rows').innerHTML = '';
  } else {
    const top = rows[0];
    const words = conditionWords(pO);
    let why = words.length
      ? `It's ${listJoin(words)} today. Only ${mins(top.best.outOrigin + top.best.outDest)} outside to reach.`
      : `Weather ok, only ${mins(top.best.totalMin)} away.`;
    const mood = moodPrefix(conditionsAt(state.raw, office.lat, office.lng));
    if (mood) why = `${mood} ${why}`;
    if (state.sensitive && pO.haze + pO.heat > 0) why += ' Ranked with sensitive mode on.';
    $('#lunch-verdict').innerHTML = `<div class="big">${esc(top.place.name)}: ${esc(top.best.label.toLowerCase())}</div><div class="why">${esc(why)} Showing places ${esc(budgetText)} per pax.</div><div class="how">${esc(howLine(pO, pO))}</div>`;
    const shown = rows.slice(0, 15);
    const maxFeels = Math.max(...shown.map((r) => r.best.feelsLike));
    $('#lunch-rows').innerHTML = shown
      .map(({ place, price, best }, i) => {
        const priceHtml =
          price.tier == null
            ? '<span class="pill plain">unknown</span>'
            : `<span class="pill plain" title="${price.source === 'hawker' ? 'Hawker centre' : 'Curated estimate'}">${TIER_SIGNS[price.tier]}</span>`;
        const how =
          best.mode === 'walk'
            ? `Walk ${Math.round(best.distM)} m`
            : `Bus ${esc(best.trip.service)} · ${best.trip.alight.nStops} stop${best.trip.alight.nStops > 1 ? 's' : ''}<div class="sub">from ${esc(best.trip.board.name)}${best.live ? `, next in ${mins(best.live.eta)}` : ''}</div>`;
        const out = best.outOrigin + best.outDest;
        const cls = out < 4 ? 'good' : out * (pO.total - 1) < 8 ? 'meh' : 'bad';
        return `<tr class="${i === 0 ? 'best' : ''}">
          <td><div class="mode">${esc(place.name)}</div><div class="sub">${esc(kindLabel(place.kind))}${place.cuisine ? ' · ' + esc(place.cuisine) : ''}</div>${lunchReason(best)}</td>
          <td>${priceHtml}</td>
          <td>${how}</td>
          <td><span class="pill ${cls}">${mins(out)}</span></td>
          <td class="num hide-sm">${mins(best.totalMin)}</td>
          <td class="num">${feelsBar(best, maxFeels)}</td>
        </tr>`;
      })
      .join('');
  }

  const notes = [`${rows.length} places match within ${lunchRadiusM / 1000} km. One-way trip from ${office.name}.`];
  if (state.osmError) notes.push(`Pai seh, restaurants cannot load (OpenStreetMap: ${state.osmError}). Showing hawker centres only.`);
  else if (!state.osm) notes.push('Still loading the restaurants, wait ah…');
  notes.push('$ tiers are curated estimates for chains; hawker centres are $.');
  $('#lunch-note').textContent = notes.join(' ');
}

// ---------- shell ----------

function renderSources() {
  const label = {
    forecast: '2-hour forecast (data.gov.sg)',
    rainfall: 'Rainfall (data.gov.sg)',
    pm25: 'PM2.5 (data.gov.sg)',
    psi: 'PSI (data.gov.sg)',
    uv: 'UV index (data.gov.sg)',
    temp: 'Air temperature (data.gov.sg)',
    taxis: 'Taxi availability (data.gov.sg)',
    bus: 'Bus stops & routes (busrouter.sg)',
    arrivals: 'Bus arrivals (arrivelah)',
    osm: 'Restaurants (OpenStreetMap, © contributors, ODbL)',
  };
  $('#sources').innerHTML = Object.entries(label)
    .map(([k, name]) => {
      const s = state.sources[k];
      const st = !s ? 'loading…' : s.error ? `<span class="err">unavailable (${esc(s.error)})</span>` : `${s.stale ? 'stale copy from ' : 'fetched '}${clock(new Date(s.at))}`;
      return `<li>${esc(name)}: ${st}</li>`;
    })
    .join('') + '<li>Hawker centres: NEA via data.gov.sg (bundled)</li>';
}

// Spell out what the switch does in today's conditions, in minutes.
function renderSensitive(cO) {
  const on = state.sensitive;
  $('#sensitive-row').classList.toggle('on', on);
  $('#sensitive').checked = on;
  const pill = $('#sensitive-state');
  pill.textContent = on ? 'On' : 'Off';
  pill.className = `pill ${on ? 'on' : 'plain'}`;

  const extra = (s) => {
    const p = penalty({ ...cO.inputs, rainMm: 0, forecastText: '' }, s);
    return EXTRA_COST_PER_OUTDOOR_MIN * (p.total - 1);
  };
  const normal = extra(false);
  const sens = extra(true);
  let desc;
  if (!state.raw.psi && !state.raw.temp) {
    desc = 'On this and haze, heat and UV count double, so options with less walking go up.';
  } else if (sens === 0) {
    desc = `Haze and heat ok now, so no difference yet. When they go up, ${on ? 'they count' : 'on this and they count'} double.`;
  } else if (on) {
    desc = `On liao. Haze, heat and UV count double. Now each minute outside adds ${sens.toFixed(1)} min to "feels like" instead of ${normal.toFixed(1)} min, so short-walk options go up.`;
  } else {
    desc = `For asthma, allergies or cannot tahan heat. On this and each minute outside adds ${sens.toFixed(1)} min to "feels like" instead of ${normal.toFixed(1)} min.`;
  }
  $('#sensitive-desc').textContent = desc;
}

function render() {
  if (!state.cfg) return;
  const { office, home } = state.cfg;
  const cO = conditionsAt(state.raw, office.lat, office.lng);
  const cD = conditionsAt(state.raw, home.lat, home.lng);
  const pO = penalty(cO.inputs, state.sensitive);
  const pD = penalty(cD.inputs, state.sensitive);
  renderAlerts(cO, cD);
  renderConditions(cO, cD);
  renderSensitive(cO);
  if (state.tab === 'home') renderHome(pO, pD, cO);
  else renderLunch(pO);
  renderSources();
}

function setTab(tab) {
  state.tab = tab;
  pref.set('tab', tab);
  for (const b of document.querySelectorAll('[role=tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  $('#home').hidden = tab !== 'home';
  $('#lunch').hidden = tab !== 'lunch';
  render();
}

function bind() {
  $('#sensitive').checked = state.sensitive;
  $('#sensitive').addEventListener('change', (e) => {
    state.sensitive = e.target.checked;
    pref.set('sensitive', state.sensitive);
    render();
  });
  $('#refresh').addEventListener('click', refresh);
  for (const b of document.querySelectorAll('[role=tab]')) b.addEventListener('click', () => setTab(b.dataset.tab));
  $('#budget').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tier]');
    if (!b) return;
    state.budget = +b.dataset.tier;
    pref.set('budget', state.budget);
    renderLunchControls();
    render();
  });
  $('#kinds').addEventListener('click', (e) => {
    const b = e.target.closest('[data-kind]');
    if (!b) return;
    const k = b.dataset.kind;
    if (state.kinds.has(k)) state.kinds.delete(k);
    else state.kinds.add(k);
    pref.set('kinds', [...state.kinds]);
    renderLunchControls();
    render();
  });
  $('#unknown').addEventListener('change', (e) => {
    state.includeUnknown = e.target.checked;
    pref.set('unknown', state.includeUnknown);
    render();
  });
}

async function init() {
  try {
    const [cfg, prices, hawkers] = await Promise.all([
      loadLocal('data/config.json?v=202610060557'),
      loadLocal('data/prices.json?v=202610060557'),
      loadLocal('data/hawkers.json?v=202610060557'),
    ]);
    state.cfg = cfg;
    state.prices = prices;
    state.hawkers = hawkers.hawkers;
    if (state.budget == null) state.budget = cfg.defaultBudgetTier;
  } catch (err) {
    $('#status').innerHTML = `<span class="err">${esc(err.message)}. Serve this folder over http (see README).</span>`;
    return;
  }
  bind();
  renderLunchControls();
  setTab(state.tab);
  loadOsm();
  await refresh();
  setInterval(() => {
    if (document.visibilityState === 'visible') refresh();
  }, 60000);
}

init();
