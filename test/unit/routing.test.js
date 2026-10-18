// Unit tests for src/routing/valhalla.js and src/routing/stub.js.
// No network: every ValhallaRouter gets a fake fetch.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  VALHALLA_ENDPOINT,
  VALHALLA_MAX_AVOID,
  buildValhallaRequest,
  parseValhallaResponse,
  ValhallaRouter,
} from '../../src/routing/valhalla.js';
import { STUB_SPEED_MPS, STUB_OFFSETS_M, StubRouter } from '../../src/routing/stub.js';
import { USER_AGENT, InputError, NoRouteError, UpstreamError } from '../../src/types.js';
import { encodePolyline, haversineM, lineLengthM, pointToPolylineM } from '../../src/geo.js';

const FIXTURES = new URL('../fixtures/routing/', import.meta.url);
/** @param {string} name */
const fixture = (name) => JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8'));

const START = { lat: 33.749, lon: -84.388 };
const END = { lat: 33.7756, lon: -84.3963 };

/** n distinct points around Atlanta. */
const manyPoints = (n) => Array.from({ length: n }, (_, i) => ({ lat: 33.7 + i * 0.001, lon: -84.3 - i * 0.001 }));

/** A minimal Valhalla /route body from [lat, lon][] legs. */
function tripJson(legs, lengthKm = 1, timeS = 60) {
  return {
    trip: {
      legs: legs.map((shape) => ({ shape: encodePolyline(shape, 6), summary: { length: 0, time: 0 } })),
      summary: { length: lengthKm, time: timeS },
      status: 0,
      units: 'kilometers',
    },
  };
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Fake fetch recording (url, init) and answering with respond(). */
function fakeFetch(respond) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    return respond();
  };
  f.calls = calls;
  return f;
}

const isUpstream = (err) => {
  assert.ok(err instanceof UpstreamError, `expected UpstreamError, got ${err?.name}: ${err?.message}`);
  assert.equal(err.service, 'valhalla');
  assert.equal(err.code, 'UPSTREAM');
  return true;
};
const isInput = (err) => {
  assert.ok(err instanceof InputError, `expected InputError, got ${err?.name}: ${err?.message}`);
  assert.equal(err.code, 'INPUT');
  return true;
};
const isNoRoute = (err) => {
  assert.ok(err instanceof NoRouteError, `expected NoRouteError, got ${err?.name}: ${err?.message}`);
  assert.equal(err.code, 'NO_ROUTE');
  return true;
};

// ---------------------------------------------------------------------------

describe('buildValhallaRequest', () => {
  test('builds the documented body without exclude_locations when avoid is empty', () => {
    assert.deepStrictEqual(buildValhallaRequest({ start: START, end: END, avoid: [], avoidRadiusM: 75 }), {
      locations: [
        { lat: 33.749, lon: -84.388 },
        { lat: 33.7756, lon: -84.3963 },
      ],
      costing: 'auto',
      units: 'kilometers',
      directions_type: 'none',
    });
  });

  test('treats a missing avoid list as empty', () => {
    const body = buildValhallaRequest(/** @type {any} */ ({ start: START, end: END, avoidRadiusM: 75 }));
    assert.equal('exclude_locations' in body, false);
  });

  test('copies only lat/lon from points (extra fields such as camera ids are dropped)', () => {
    const cam = { id: 'osm:node/1', lat: 33.76, lon: -84.39, isFlock: true };
    const body = buildValhallaRequest({
      start: /** @type {any} */ ({ ...START, name: 'home' }),
      end: END,
      avoid: [cam],
      avoidRadiusM: 50,
    });
    assert.deepStrictEqual(body.locations[0], { lat: 33.749, lon: -84.388 });
    assert.deepStrictEqual(body.exclude_locations, [{ lat: 33.76, lon: -84.39, radius: 50 }]);
  });

  test('rounds the radius to whole meters (half rounds up)', () => {
    const r = (m) => buildValhallaRequest({ start: START, end: END, avoid: [START], avoidRadiusM: m }).exclude_locations[0].radius;
    assert.equal(r(74.4), 74);
    assert.equal(r(74.5), 75);
    assert.equal(r(300), 300);
    assert.equal(r(0), 0);
  });

  test('accepts 50 avoid points and rejects 51 with InputError', () => {
    assert.equal(VALHALLA_MAX_AVOID, 50);
    const ok = buildValhallaRequest({ start: START, end: END, avoid: manyPoints(50), avoidRadiusM: 75 });
    assert.equal(ok.exclude_locations.length, 50);
    assert.throws(() => buildValhallaRequest({ start: START, end: END, avoid: manyPoints(51), avoidRadiusM: 75 }), isInput);
  });

  test('rejects bad points, a bad avoid list and a bad radius with InputError', () => {
    const bad = [
      { start: null, end: END, avoid: [] },
      { start: { lat: '33.7', lon: -84.3 }, end: END, avoid: [] },
      { start: START, end: { lat: 33.7 }, avoid: [] },
      { start: START, end: { lat: 91, lon: 0 }, avoid: [] },
      { start: START, end: END, avoid: 'none' },
      { start: START, end: END, avoid: [{ lat: NaN, lon: -84.3 }], avoidRadiusM: 75 },
      { start: START, end: END, avoid: [START], avoidRadiusM: -1 },
      { start: START, end: END, avoid: [START], avoidRadiusM: Infinity },
      { start: START, end: END, avoid: [START] },
    ];
    for (const req of bad) {
      assert.throws(() => buildValhallaRequest(/** @type {any} */ (req)), isInput, JSON.stringify(req));
    }
    assert.throws(() => buildValhallaRequest(/** @type {any} */ (null)), isInput);
  });

  test('does not mutate the request', () => {
    const req = { start: { ...START }, end: { ...END }, avoid: [{ lat: 33.76, lon: -84.39 }], avoidRadiusM: 74.6 };
    const copy = structuredClone(req);
    buildValhallaRequest(req);
    assert.deepStrictEqual(req, copy);
  });
});

describe('parseValhallaResponse', () => {
  test('parses a realistic two-leg response fixture', () => {
    const route = parseValhallaResponse(fixture('valhalla-route-2legs.json'));
    const expected = fixture('valhalla-route-2legs.points.json');
    assert.equal(route.points.length, expected.length);
    route.points.forEach((p, i) => {
      assert.ok(Math.abs(p[0] - expected[i][0]) < 1e-9 && Math.abs(p[1] - expected[i][1]) < 1e-9, `point ${i}`);
    });
    assert.equal(route.distanceM, 3305);
    assert.equal(route.durationS, 420.2);
  });

  test('joins three legs, dropping each shared joint once', () => {
    const a = [[33.7, -84.4], [33.71, -84.41]];
    const b = [[33.71, -84.41], [33.72, -84.42]];
    const c = [[33.72, -84.42], [33.73, -84.43], [33.74, -84.44]];
    const route = parseValhallaResponse(tripJson([a, b, c], 4.5, 500));
    assert.deepStrictEqual(route.points, [a[0], a[1], b[1], c[1], c[2]]);
    assert.equal(route.distanceM, 4500);
    assert.equal(route.durationS, 500);
  });

  test('keeps both points when consecutive legs do not share a joint', () => {
    const route = parseValhallaResponse(tripJson([[[33.7, -84.4], [33.71, -84.41]], [[33.715, -84.415], [33.72, -84.42]]]));
    assert.equal(route.points.length, 4);
  });

  test('decodes at precision 6 (not the Google default of 5)', () => {
    const shape = [[33.123456, -84.654321], [33.123999, -84.654001]];
    const route = parseValhallaResponse(tripJson([shape]));
    assert.deepStrictEqual(route.points, shape);
  });

  test('throws UpstreamError for missing or malformed trips', () => {
    const good = () => tripJson([[[33.7, -84.4], [33.71, -84.41]]], 1.2, 90);
    const cases = {
      undefined: undefined,
      array: [],
      'trip is an array': { trip: [] },
      'legs empty': (() => { const j = good(); j.trip.legs = []; return j; })(),
      'legs not array': (() => { const j = good(); j.trip.legs = {}; return j; })(),
      'leg null': (() => { const j = good(); j.trip.legs = [null]; return j; })(),
      'shape missing': (() => { const j = good(); delete j.trip.legs[0].shape; return j; })(),
      'shape not a polyline': (() => { const j = good(); j.trip.legs[0].shape = 'a b c'; return j; })(),
      'shape truncated': (() => { const j = good(); j.trip.legs[0].shape = '_'; return j; })(),
      'single point': (() => { const j = good(); j.trip.legs[0].shape = encodePolyline([[33.7, -84.4]]); return j; })(),
      'length is a string': (() => { const j = good(); j.trip.summary.length = '1.2'; return j; })(),
      'time missing': (() => { const j = good(); delete j.trip.summary.time; return j; })(),
      'negative length': (() => { const j = good(); j.trip.summary.length = -1; return j; })(),
      'error 442 body': fixture('valhalla-error-442.json'),
    };
    for (const [label, body] of Object.entries(cases)) {
      assert.throws(() => parseValhallaResponse(body), isUpstream, label);
    }
  });

  test('error messages start with "valhalla: "', () => {
    assert.throws(() => parseValhallaResponse({}), (err) => err.message.startsWith('valhalla: '));
  });
});

describe('ValhallaRouter', () => {
  const req = { start: START, end: END, avoid: [{ lat: 33.7601, lon: -84.3902 }], avoidRadiusM: 75 };

  test('defaults: name, maxAvoid, endpoint, user agent, global fetch', () => {
    const r = new ValhallaRouter();
    assert.equal(r.name, 'valhalla');
    assert.equal(r.maxAvoid, 50);
    assert.equal(r.endpoint, VALHALLA_ENDPOINT);
    assert.equal(r.userAgent, USER_AGENT);
    assert.equal(r.fetch, globalThis.fetch);
  });

  test('POSTs JSON with Content-Type and User-Agent headers and returns the parsed route', async () => {
    const fetch = fakeFetch(() => json(fixture('valhalla-route-2legs.json')));
    const route = await new ValhallaRouter({ fetch, userAgent: 'unit-test/1' }).route(req);
    assert.equal(fetch.calls.length, 1);
    const { url, init } = fetch.calls[0];
    assert.equal(url, VALHALLA_ENDPOINT);
    assert.equal(init.method, 'POST');
    const headers = new Headers(init.headers);
    assert.equal(headers.get('content-type'), 'application/json');
    assert.equal(headers.get('user-agent'), 'unit-test/1');
    assert.deepStrictEqual(JSON.parse(init.body), buildValhallaRequest(req));
    assert.equal(route.distanceM, 3305);
    assert.equal(route.points.length, fixture('valhalla-route-2legs.points.json').length);
  });

  test('maps 400 + error_code 442 and 171 to NoRouteError with the Valhalla text', async () => {
    for (const name of ['valhalla-error-442.json', 'valhalla-error-171.json']) {
      const body = fixture(name);
      const fetch = fakeFetch(() => json(body, 400));
      await assert.rejects(new ValhallaRouter({ fetch }).route(req), (err) => {
        isNoRoute(err);
        assert.ok(err.message.includes(body.error), err.message);
        return true;
      }, name);
    }
  });

  test('maps other 400 error codes (e.g. 157 too many avoid locations) to UpstreamError with the code in the message', async () => {
    const fetch = fakeFetch(() => json(fixture('valhalla-error-157.json'), 400));
    await assert.rejects(new ValhallaRouter({ fetch }).route(req), (err) => {
      isUpstream(err);
      assert.match(err.message, /HTTP 400/);
      assert.match(err.message, /157/);
      return true;
    });
  });

  test('a 442 code on a non-400 status is still an upstream failure', async () => {
    const fetch = fakeFetch(() => json(fixture('valhalla-error-442.json'), 500));
    await assert.rejects(new ValhallaRouter({ fetch }).route(req), isUpstream);
  });

  test('maps rate limiting, server errors, bad JSON and network errors to UpstreamError', async () => {
    const responders = {
      429: () => new Response('Too Many Requests', { status: 429 }),
      503: () => json({ error: 'overloaded' }, 503),
      'bad json': () => new Response('{"trip":', { status: 200 }),
      'empty body': () => new Response('', { status: 200 }),
      'network': () => { throw new TypeError('fetch failed'); },
      'body read fails': () => ({ ok: true, status: 200, text: async () => { throw new Error('aborted'); } }),
    };
    for (const [label, respond] of Object.entries(responders)) {
      const fetch = fakeFetch(respond);
      await assert.rejects(new ValhallaRouter({ fetch }).route(req), isUpstream, label);
    }
  });

  test('rejects with UpstreamError when no fetch function is available', async () => {
    const r = new ValhallaRouter();
    r.fetch = /** @type {any} */ (undefined);
    await assert.rejects(r.route(req), isUpstream);
  });

  test('checks input before calling fetch', async () => {
    const fetch = fakeFetch(() => json(fixture('valhalla-route-2legs.json')));
    const r = new ValhallaRouter({ fetch });
    await assert.rejects(r.route({ ...req, avoid: manyPoints(51) }), isInput);
    await assert.rejects(r.route(/** @type {any} */ ({ ...req, start: { lat: 'x', lon: 1 } })), isInput);
    assert.equal(fetch.calls.length, 0);
  });

  test('honors a maxAvoid lowered below the Valhalla limit', async () => {
    const fetch = fakeFetch(() => json(fixture('valhalla-route-2legs.json')));
    const r = new ValhallaRouter({ fetch });
    r.maxAvoid = 2;
    await assert.rejects(r.route({ ...req, avoid: manyPoints(3) }), isInput);
    await r.route({ ...req, avoid: manyPoints(2) });
    assert.equal(fetch.calls.length, 1);
  });
});

// ---------------------------------------------------------------------------

// Northbound trip of about 4.4 km: left of travel is west, right is east.
const N_START = { lat: 33.73, lon: -84.39 };
const N_END = { lat: 33.77, lon: -84.39 };
const N_MID = { lat: 33.75, lon: -84.39 };
const R = 100;
const M_PER_DEG_LAT = (6_371_008.8 * Math.PI) / 180;
const mPerDegLon = (lat) => M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
/** Point east (+) or west (-) of N_MID by meters. */
const eastOfMid = (m) => ({ lat: N_MID.lat, lon: N_MID.lon + m / mPerDegLon(N_MID.lat) });

describe('StubRouter', () => {
  test('constants and identity', () => {
    const r = new StubRouter();
    assert.equal(r.name, 'stub');
    assert.equal(r.maxAvoid, 50);
    assert.equal(STUB_SPEED_MPS, 40_000 / 3600);
    assert.deepStrictEqual(STUB_OFFSETS_M, [500, 1000, 2000, 4000]);
  });

  test('straight line with no avoid points, with distance and duration from geo', async () => {
    const route = await new StubRouter().route({ start: N_START, end: N_END, avoid: [], avoidRadiusM: R });
    assert.deepStrictEqual(route.points, [[33.73, -84.39], [33.77, -84.39]]);
    assert.equal(route.distanceM, haversineM(N_START, N_END));
    assert.equal(route.durationS, route.distanceM / STUB_SPEED_MPS);
  });

  test('treats a missing avoid list as empty and ignores the radius then', async () => {
    const route = await new StubRouter().route(/** @type {any} */ ({ start: N_START, end: N_END }));
    assert.equal(route.points.length, 2);
  });

  test('an avoid point exactly at the radius blocks the line (inclusive)', async () => {
    const p = eastOfMid(R);
    const d = pointToPolylineM(p, [[N_START.lat, N_START.lon], [N_END.lat, N_END.lon]]);
    const route = await new StubRouter().route({ start: N_START, end: N_END, avoid: [p], avoidRadiusM: d });
    assert.equal(route.points.length, 3);
  });

  test('northbound trip: first dog-leg goes 500 m west (left of travel)', async () => {
    const route = await new StubRouter().route({ start: N_START, end: N_END, avoid: [N_MID], avoidRadiusM: R });
    assert.equal(route.points.length, 3);
    const [lat, lon] = route.points[1];
    assert.ok(Math.abs(lat - N_MID.lat) < 1e-9, 'waypoint stays on the midpoint latitude');
    const offsetM = (lon - N_MID.lon) * mPerDegLon(N_MID.lat);
    assert.ok(Math.abs(offsetM + 500) < 1, `expected 500 m west, got ${offsetM.toFixed(2)} m`);
    assert.equal(route.distanceM, lineLengthM(route.points));
  });

  test('southbound trip mirrors it: first dog-leg goes 500 m east', async () => {
    const route = await new StubRouter().route({ start: N_END, end: N_START, avoid: [N_MID], avoidRadiusM: R });
    const offsetM = (route.points[1][1] - N_MID.lon) * mPerDegLon(N_MID.lat);
    assert.ok(Math.abs(offsetM - 500) < 1, `expected 500 m east, got ${offsetM.toFixed(2)} m`);
  });

  test('moves to the right side when the left 500 m dog-leg is blocked', async () => {
    const route = await new StubRouter().route({ start: N_START, end: N_END, avoid: [N_MID, eastOfMid(-500)], avoidRadiusM: R });
    const offsetM = (route.points[1][1] - N_MID.lon) * mPerDegLon(N_MID.lat);
    assert.ok(Math.abs(offsetM - 500) < 1, `expected 500 m east, got ${offsetM.toFixed(2)} m`);
  });

  test('falls back to the dog-leg with the fewest hits when none is clear', async () => {
    // Start is blocked for every candidate; both 500 m and 1000 m waypoints add a hit,
    // so the 2000 m west dog-leg (fewest hits, first in order) wins.
    const avoid = [N_START, eastOfMid(-500), eastOfMid(500), eastOfMid(-1000), eastOfMid(1000)];
    const route = await new StubRouter().route({ start: N_START, end: N_END, avoid, avoidRadiusM: R });
    const offsetM = (route.points[1][1] - N_MID.lon) * mPerDegLon(N_MID.lat);
    assert.ok(Math.abs(offsetM + 2000) < 2, `expected 2000 m west, got ${offsetM.toFixed(2)} m`);
  });

  test('start equal to end: a blocked zero-length trip still resolves to a dog-leg (travel taken as east, left as north)', async () => {
    const route = await new StubRouter().route({ start: N_MID, end: N_MID, avoid: [N_MID], avoidRadiusM: R });
    assert.equal(route.points.length, 3);
    const northM = (route.points[1][0] - N_MID.lat) * M_PER_DEG_LAT;
    assert.ok(Math.abs(northM - 500) < 1, `expected 500 m north, got ${northM.toFixed(2)} m`);
    assert.ok(Number.isFinite(route.distanceM) && Number.isFinite(route.durationS));
  });

  test('works across the antimeridian without wrapping the long way round', async () => {
    const start = { lat: 0, lon: 179.99 };
    const end = { lat: 0, lon: -179.99 };
    const route = await new StubRouter().route({ start, end, avoid: [{ lat: 0, lon: 180 }], avoidRadiusM: R });
    assert.equal(route.points.length, 3);
    assert.ok(Math.abs(Math.abs(route.points[1][1]) - 180) < 0.01, `waypoint near 180, got ${route.points[1][1]}`);
    assert.ok(route.distanceM < 5000, `short distance, got ${route.distanceM}`);
  });

  test('rejects bad input with InputError and never NoRouteError', async () => {
    const r = new StubRouter();
    const bad = [
      null,
      { start: null, end: N_END, avoid: [] },
      { start: N_START, end: { lat: 33.7, lon: 200 }, avoid: [] },
      { start: N_START, end: N_END, avoid: {} },
      { start: N_START, end: N_END, avoid: [{ lat: 1 }], avoidRadiusM: R },
      { start: N_START, end: N_END, avoid: [N_MID], avoidRadiusM: NaN },
      { start: N_START, end: N_END, avoid: [N_MID], avoidRadiusM: -5 },
      { start: N_START, end: N_END, avoid: manyPoints(51), avoidRadiusM: R },
    ];
    for (const req of bad) await assert.rejects(r.route(/** @type {any} */ (req)), isInput, JSON.stringify(req));
  });

  test('does not mutate the request and returns fresh point arrays', async () => {
    const req = { start: { ...N_START }, end: { ...N_END }, avoid: [{ ...N_MID }], avoidRadiusM: R };
    const copy = structuredClone(req);
    const a = await new StubRouter().route(req);
    assert.deepStrictEqual(req, copy);
    a.points[0][0] = 0;
    const b = await new StubRouter().route(req);
    assert.equal(b.points[0][0], N_START.lat);
  });
});
