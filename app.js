import * as api from './lib/api.js';
import { conditionsAt } from './lib/conditions.js';
import { penalty, rankOptions, feelsLikeMin, rainFactor, hazeFactor, heatFactor, taxiWaitMin, taxiFare, waitingHelps } from './lib/score.js';
import { directTrips, reachableStops, catchableBus } from './lib/bus.js';
import { hawkerPlaces, mergePlaces, priceTier, lunchOptions, kindLabel } from './lib/places.js';
import { distM, walkMin } from './lib/geo.js';

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
  $('#status').textContent = 'Updating…';
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
      label: 'Taxi / ride-hail',
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

function conditionWords(p) {
  const w = [];
  if (p.rain >= 1.5) w.push('raining');
  else if (p.rain > 0) w.push('drizzly');
  if (p.haze >= 0.5) w.push('hazy');
  if (p.heat >= 0.3) w.push('hot');
  return w;
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
    $('#home-verdict').innerHTML = `<div class="big">Loading options…</div>`;
    $('#home-rows').innerHTML = '';
    return;
  }
  const best = ranked[0];
  const words = [...new Set([...conditionWords(pO), ...conditionWords(pD)])];
  const fastest = [...ranked].sort((a, b) => a.totalMin - b.totalMin)[0];
  let why;
  if (!words.length) why = "Weather's fine, so the quickest door-to-door option wins.";
  else {
    why = `It's ${words.join(' and ')}. This option keeps you outside for ${mins(best.outOrigin + best.outDest)}`;
    if (fastest !== best) why += `, vs ${mins(fastest.outOrigin + fastest.outDest)} for the quicker ${fastest.label}`;
    why += '.';
  }
  const leave = best.mode === 'wait' ? 'wait 30 min first' : best.leaveIn < 0.5 ? 'leave now' : `leave in ${mins(best.leaveIn)}`;
  $('#home-verdict').innerHTML = `<div class="big">${esc(best.label)}: ${leave}, home by ${clock(inMin(best.totalMin))}</div><div class="why">${esc(why)}</div>`;

  $('#home-rows').innerHTML = ranked
    .slice(0, 8)
    .map(
      (o, i) => `<tr class="${i === 0 ? 'best' : ''}">
        <td><div class="mode">${esc(o.label)}</div><div class="sub">${esc(o.detail)}</div></td>
        <td class="num">${leaveText(o)}</td>
        <td>${outdoorPill(o, pO, pD)}</td>
        <td class="num hide-sm">${mins(o.totalMin)}</td>
        <td class="num">${clock(inMin(o.totalMin))}</td>
        <td class="num"><strong>${mins(o.feelsLike)}</strong></td>
      </tr>`,
    )
    .join('');

  const notes = [`To ${home.name.toLowerCase()} (${home.address}). Bus times are live from arrivelah; MRT ride times are typical, not live.`];
  if (notRunning.length) notes.push(`No catchable arrival right now for bus ${notRunning.join(', ')}.`);
  if (ranked.length > 8) notes.push(`${ranked.length - 8} slower options hidden.`);
  $('#home-note').textContent = notes.join(' ');
}

// ---------- lunch ----------

function renderLunchControls() {
  const tiers = state.prices.tiers;
  $('#budget').innerHTML = Object.keys(tiers)
    .map((t) => `<button class="chip" type="button" data-tier="${t}" aria-pressed="${+t === state.budget}">Up to ${TIER_SIGNS[t]} <span class="sub">(${esc(tiers[t])})</span></button>`)
    .join('');
  $('#kinds').innerHTML = KINDS.map((k) => `<button class="chip" type="button" data-kind="${k}" aria-pressed="${state.kinds.has(k)}">${esc(kindLabel(k))}</button>`).join('');
  $('#unknown').checked = state.includeUnknown;
}

function renderLunch(pO) {
  const { office, lunchRadiusM } = state.cfg;
  if (!state.bus) {
    $('#lunch-verdict').innerHTML = '<div class="big">Loading bus data…</div>';
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

  const budgetText = `${TIER_SIGNS[state.budget]} (${state.prices.tiers[state.budget]})`;
  if (!rows.length) {
    $('#lunch-verdict').innerHTML = `<div class="big">Nothing matches up to ${esc(budgetText)}</div><div class="why">Try a higher budget, more place types, or include unknown prices.</div>`;
    $('#lunch-rows').innerHTML = '';
  } else {
    const top = rows[0];
    const words = conditionWords(pO);
    const why = words.length
      ? `It's ${words.join(' and ')}: only ${mins(top.best.outOrigin + top.best.outDest)} outside to get there.`
      : `Weather's fine: ${mins(top.best.totalMin)} away.`;
    $('#lunch-verdict').innerHTML = `<div class="big">${esc(top.place.name)}: ${esc(top.best.label.toLowerCase())}</div><div class="why">${esc(why)} Showing places up to ${esc(budgetText)} per person.</div>`;
    $('#lunch-rows').innerHTML = rows
      .slice(0, 15)
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
          <td><div class="mode">${esc(place.name)}</div><div class="sub">${esc(kindLabel(place.kind))}${place.cuisine ? ' · ' + esc(place.cuisine) : ''}</div></td>
          <td>${priceHtml}</td>
          <td>${how}</td>
          <td><span class="pill ${cls}">${mins(out)}</span></td>
          <td class="num hide-sm">${mins(best.totalMin)}</td>
          <td class="num"><strong>${mins(best.feelsLike)}</strong></td>
        </tr>`;
      })
      .join('');
  }

  const notes = [`${rows.length} places match within ${lunchRadiusM / 1000} km. One-way trip from ${office.name}.`];
  if (state.osmError) notes.push(`Restaurants unavailable (OpenStreetMap: ${state.osmError}); showing hawker centres only.`);
  else if (!state.osm) notes.push('Loading restaurants from OpenStreetMap…');
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

function render() {
  if (!state.cfg) return;
  const { office, home } = state.cfg;
  const cO = conditionsAt(state.raw, office.lat, office.lng);
  const cD = conditionsAt(state.raw, home.lat, home.lng);
  const pO = penalty(cO.inputs, state.sensitive);
  const pD = penalty(cD.inputs, state.sensitive);
  renderConditions(cO, cD);
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
      loadLocal('data/config.json'),
      loadLocal('data/prices.json'),
      loadLocal('data/hawkers.json'),
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
