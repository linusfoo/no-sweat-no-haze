import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rainFactor, hazeFactor, heatFactor, penalty, rankOptions, waitingHelps, feelsLikeMin } from '../lib/score.js';
import { catchableBus } from '../lib/bus.js';
import { priceTier, mergePlaces } from '../lib/places.js';

const dry = { forecastText: 'Fair & Warm', rainMm: 0, pm25: 20, psi: 40, tempC: 30, uv: 2 };
const wet = { forecastText: 'Thundery Showers', rainMm: 3, pm25: 20, psi: 40, tempC: 27, uv: 1 };

// MRT: quick but 10 min of walking. Taxi: slower to arrive, ~2 min outside.
const mrt = { label: 'MRT', totalMin: 40, outOrigin: 4, outDest: 6 };
const taxi = { label: 'Taxi', totalMin: 45, outOrigin: 1, outDest: 1 };

test('rain factor reads forecast text and observed rain', () => {
  assert.equal(rainFactor('Fair & Warm', 0), 0);
  assert.equal(rainFactor('Partly Cloudy (Day)', 0), 0);
  assert.equal(rainFactor('Light Showers', 0), 0.8);
  assert.equal(rainFactor('Showers', 0), 1.5);
  assert.equal(rainFactor('Heavy Thundery Showers with Gusty Winds', 0), 2);
  assert.equal(rainFactor('Fair', 0.2), 1.5); // raining despite a fair forecast
  assert.equal(rainFactor('Thundery Showers', 5), 2.5);
});

test('haze uses the worse of PM2.5 and PSI bands, doubled when sensitive', () => {
  assert.equal(hazeFactor(20, 40), 0);
  assert.equal(hazeFactor(95, 133), 0.6);
  assert.equal(hazeFactor(95, 133, true), 1.2);
  assert.equal(hazeFactor(300, 350), 2.5);
});

test('heat adds for high temperature and UV', () => {
  assert.equal(heatFactor(30, 2), 0);
  assert.equal(heatFactor(34, 9), 0.65);
});

test('fine weather: fastest option wins', () => {
  const p = penalty(dry);
  assert.equal(p.total, 1);
  const ranked = rankOptions([taxi, mrt], p, p);
  assert.equal(ranked[0].label, 'MRT');
  assert.equal(ranked[0].feelsLike, 40);
});

test('heavy rain: least outdoor exposure wins', () => {
  const p = penalty(wet);
  const ranked = rankOptions([mrt, taxi], p, p);
  assert.equal(ranked[0].label, 'Taxi');
  assert.ok(feelsLikeMin(mrt, p, p) > feelsLikeMin(taxi, p, p));
});

test('rain only at the destination counts only the destination walk', () => {
  const pO = penalty(dry);
  const pD = penalty(wet);
  const walkAtStart = { totalMin: 40, outOrigin: 10, outDest: 0 };
  const walkAtEnd = { totalMin: 40, outOrigin: 0, outDest: 10 };
  assert.equal(feelsLikeMin(walkAtStart, pO, pD), 40);
  assert.ok(feelsLikeMin(walkAtEnd, pO, pD) > 40);
});

test('waiting helps only for a passing shower', () => {
  assert.equal(waitingHelps('Partly Cloudy (Day)', 1.2), true);
  assert.equal(waitingHelps('Thundery Showers', 1.2), false);
  assert.equal(waitingHelps('Fair', 0), false);
});

test('catchable bus: skip buses you cannot reach, wait indoors for the rest', () => {
  const trip = { service: '21', board: { code: '60059' }, walkTo: 4 };
  const arrivals = { 60059: { 21: [2, 9, 20] } };
  const live = catchableBus(trip, arrivals);
  assert.equal(live.eta, 9);
  assert.equal(live.waitAtStop, 2);
  assert.equal(live.leaveInMin, 3);
  assert.equal(catchableBus(trip, { 60059: { 21: [1] } }), null);
  assert.equal(catchableBus(trip, {}), null);
});

test('price tiers: hawker centres, curated chains, unknown', () => {
  const brands = { "McDonald's": 2, 'Ya Kun Kaya Toast': 1 };
  assert.deepEqual(priceTier({ kind: 'hawker', name: 'X' }, brands), { tier: 1, source: 'hawker' });
  assert.equal(priceTier({ kind: 'fast_food', brand: "McDonald's", name: "McDonald's Kallang" }, brands).tier, 2);
  assert.equal(priceTier({ kind: 'cafe', brand: '', name: 'Ya Kun Kaya Toast (Bendemeer)' }, brands).tier, 1);
  assert.equal(priceTier({ kind: 'restaurant', brand: '', name: 'Some Bistro' }, brands).tier, null);
});

test('OSM food courts on top of a hawker centre are dropped', () => {
  const hawkers = [{ kind: 'hawker', name: 'Golden Mile Food Centre', lat: 1.3029, lng: 103.8644 }];
  const osm = [
    { kind: 'food_court', name: 'Golden Mile Food Centre', lat: 1.3030, lng: 103.8645 },
    { kind: 'food_court', name: 'Kopitiam', lat: 1.31, lng: 103.87 },
  ];
  assert.equal(mergePlaces(hawkers, osm).length, 2);
});
