// Acceptance tests for the routing module (src/routing/valhalla.js, src/routing/stub.js).
// Written from .hub/spec.md and the interface JSDoc only, not from the implementation.
// No network: ValhallaRouter always gets a fake fetch.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  VALHALLA_ENDPOINT,
  VALHALLA_MAX_AVOID,
  buildValhallaRequest,
  parseValhallaResponse,
  ValhallaRouter,
} from '../../src/routing/valhalla.js';
import { STUB_SPEED_MPS, STUB_OFFSETS_M, StubRouter } from '../../src/routing/stub.js';
import {
  USER_AGENT,
  InputError,
  NoRouteError,
  UpstreamError,
} from '../../src/types.js';

// ---------------------------------------------------------------------------
// Test helpers (independent of src/geo.js so these tests check the spec, not the code)

const EARTH_RADIUS_M = 6_371_008.8;
const RAD = Math.PI / 180;

/** Great-circle distance in meters between {lat, lon} points. */
function haversine(a, b) {
  const dLat = (b.lat - a.lat) * RAD;
  const dLon = (b.lon - a.lon) * RAD;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Sum of haversine segment lengths of a [lat, lon][] line. */
function lineLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += haversine(
      { lat: points[i - 1][0], lon: points[i - 1][1] },
      { lat: points[i][0], lon: points[i][1] },
    );
  }
  return total;
}

/** Local flat frame (meters east, meters north) around an origin; fine for a few km. */
function toXY(origin, p) {
  return {
    x: (p.lon - origin.lon) * RAD * EARTH_RADIUS_M * Math.cos(origin.lat * RAD),
    y: (p.lat - origin.lat) * RAD * EARTH_RADIUS_M,
  };
}
function fromXY(origin, { x, y }) {
  return {
    lat: origin.lat + y / (RAD * EARTH_RADIUS_M),
    lon: origin.lon + x / (RAD * EARTH_RADIUS_M * Math.cos(origin.lat * RAD)),
  };
}

function midpoint(a, b) {
  return { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 };
}

/** Unit vectors along start->end and to its left (90 degrees counter-clockwise), in the local frame. */
function tripFrame(start, end) {
  const mid = midpoint(start, end);
  const e = toXY(mid, end);
  const s = toXY(mid, start);
  const len = Math.hypot(e.x - s.x, e.y - s.y);
  const along = { x: (e.x - s.x) / len, y: (e.y - s.y) / len };
  const left = { x: -along.y, y: along.x };
  return { mid, along, left };
}

/** Where the stub's waypoint for (side, offset) should be, per the JSDoc. */
function expectedWaypoint(start, end, side, offsetM) {
  const { mid, left } = tripFrame(start, end);
  const sign = side === 'left' ? 1 : -1;
  return fromXY(mid, { x: left.x * offsetM * sign, y: left.y * offsetM * sign });
}

/** Describe a waypoint relative to the trip: which side, how far off the line, how far along from the midpoint. */
function describeWaypoint(start, end, wp) {
  const { mid, along, left } = tripFrame(start, end);
  const p = toXY(mid, wp);
  const perp = p.x * left.x + p.y * left.y;
  const par = p.x * along.x + p.y * along.y;
  return { side: perp > 0 ? 'left' : 'right', offsetM: Math.abs(perp), alongM: par };
}

/** Candidate order the stub JSDoc promises: each offset nearest first, left side then right side. */
const CANDIDATES = STUB_OFFSETS_M.flatMap((offsetM) => [
  { side: 'left', offsetM },
  { side: 'right', offsetM },
]);

function assertWaypoint(start, end, wp, { side, offsetM }, label = '') {
  const got = describeWaypoint(start, end, { lat: wp[0], lon: wp[1] });
  const tol = offsetM * 0.02 + 5;
  assert.equal(got.side, side, `${label} waypoint should be on the ${side} side, got ${JSON.stringify(got)}`);
  assert.ok(
    Math.abs(got.offsetM - offsetM) <= tol,
    `${label} waypoint should be ${offsetM} m off the line, got ${got.offsetM.toFixed(1)} m`,
  );
  assert.ok(
    Math.abs(got.alongM) <= tol,
    `${label} waypoint should sit on the perpendicular through the midpoint, got ${got.alongM.toFixed(1)} m along`,
  );
}

function assertClose(actual, expected, relTol, message) {
  const tol = Math.abs(expected) * relTol + 1e-9;
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${message}: expected ${expected}, got ${actual}`,
  );
}

/** Google polyline encoding, written here so the tests do not depend on src/geo.js. */
function encodePolyline(points, precision = 6) {
  const factor = 10 ** precision;
  let lastLat = 0;
  let lastLon = 0;
  let out = '';
  const encodeValue = (value) => {
    let v = value < 0 ? ~(value << 1) : value << 1;
    let s = '';
    while (v >= 0x20) {
      s += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    return s + String.fromCharCode(v + 63);
  };
  for (const [lat, lon] of points) {
    const la = Math.round(lat * factor);
    const lo = Math.round(lon * factor);
    out += encodeValue(la - lastLat) + encodeValue(lo - lastLon);
    lastLat = la;
    lastLon = lo;
  }
  return out;
}

function assertPointsClose(actual, expected, message) {
  assert.ok(Array.isArray(actual), `${message}: points should be an array`);
  assert.equal(actual.length, expected.length, `${message}: point count`);
  for (let i = 0; i < expected.length; i++) {
    assert.ok(
      Math.abs(actual[i][0] - expected[i][0]) < 1e-6 && Math.abs(actual[i][1] - expected[i][1]) < 1e-6,
      `${message}: point ${i} expected ${JSON.stringify(expected[i])}, got ${JSON.stringify(actual[i])}`,
    );
  }
}

/** A Valhalla-shaped /route response. legs is a list of [lat, lon][] shapes. */
function valhallaResponse(legs, lengthKm, timeS) {
  return {
    trip: {
      locations: [],
      legs: legs.map((shape) => ({
        summary: { length: lengthKm / legs.length, time: timeS / legs.length },
        shape: encodePolyline(shape, 6),
      })),
      summary: { length: lengthKm, time: timeS },
      status_message: 'Found route between points',
      status: 0,
      units: 'kilometers',
      language: 'en-US',
    },
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Fake fetch that records every call and answers with respond(call). */
function fakeFetch(respond) {
  const calls = [];
  async function fetchImpl(input, init = {}) {
    const isRequest = typeof input === 'object' && input !== null && !(input instanceof URL) && 'url' in input;
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init.method ?? (isRequest ? input.method : 'GET')).toUpperCase();
    const headers = new Headers(init.headers ?? (isRequest ? input.headers : undefined));
    let body = init.body ?? (isRequest ? await input.text() : undefined);
    if (body != null && typeof body !== 'string') body = new TextDecoder().decode(body);
    const call = { url, method, headers, body };
    calls.push(call);
    return respond(call);
  }
  fetchImpl.calls = calls;
  return fetchImpl;
}

function assertUpstream(err) {
  assert.ok(err instanceof UpstreamError, `expected UpstreamError, got ${err && err.name}: ${err && err.message}`);
  assert.equal(err.code, 'UPSTREAM');
  assert.equal(err.service, 'valhalla');
  assert.ok(err.message.startsWith('valhalla: '), `message should start with "valhalla: ", got ${err.message}`);
  return true;
}

function assertInputError(err) {
  assert.ok(err instanceof InputError, `expected InputError, got ${err && err.name}: ${err && err.message}`);
  assert.equal(err.code, 'INPUT');
  return true;
}

function assertNoRoute(err) {
  assert.ok(err instanceof NoRouteError, `expected NoRouteError, got ${err && err.name}: ${err && err.message}`);
  assert.equal(err.code, 'NO_ROUTE');
  return true;
}

/** n distinct points spread around Atlanta. */
function manyPoints(n) {
  return Array.from({ length: n }, (_, i) => ({ lat: 33.70 + i * 0.001, lon: -84.30 - i * 0.001 }));
}

// Central Atlanta trip used in most Valhalla tests.
const START = { lat: 33.749, lon: -84.388 };
const END = { lat: 33.7756, lon: -84.3963 };

// ---------------------------------------------------------------------------
// Valhalla

describe('routing: Valhalla constants', () => {
  test('VALHALLA_ENDPOINT is the FOSSGIS public /route endpoint', () => {
    assert.equal(VALHALLA_ENDPOINT, 'https://valhalla1.openstreetmap.de/route');
  });

  test('VALHALLA_MAX_AVOID is 50', () => {
    assert.equal(VALHALLA_MAX_AVOID, 50);
  });
});

describe('routing: buildValhallaRequest', () => {
  test('with no avoid points the body is exactly {locations: [start, end], costing "auto", units "kilometers", directions_type "none"}', () => {
    const body = buildValhallaRequest({ start: START, end: END, avoid: [], avoidRadiusM: 75 });
    assert.deepStrictEqual(body, {
      locations: [
        { lat: START.lat, lon: START.lon },
        { lat: END.lat, lon: END.lon },
      ],
      costing: 'auto',
      units: 'kilometers',
      directions_type: 'none',
    });
  });

  test('omits the exclude_locations key when avoid is empty', () => {
    const body = buildValhallaRequest({ start: START, end: END, avoid: [], avoidRadiusM: 75 });
    assert.equal(Object.prototype.hasOwnProperty.call(body, 'exclude_locations'), false);
  });

  test('sends each avoid point, in order, as exclude_locations {lat, lon, radius} with avoidRadiusM rounded', () => {
    const avoid = [
      { lat: 33.7601, lon: -84.3902 },
      { lat: 33.7655, lon: -84.3921 },
    ];
    const body = buildValhallaRequest({ start: START, end: END, avoid, avoidRadiusM: 74.6 });
    assert.deepStrictEqual(body.exclude_locations, [
      { lat: 33.7601, lon: -84.3902, radius: 75 },
      { lat: 33.7655, lon: -84.3921, radius: 75 },
    ]);
    assert.deepStrictEqual(body.locations, [
      { lat: START.lat, lon: START.lon },
      { lat: END.lat, lon: END.lon },
    ]);
    assert.equal(body.costing, 'auto');
    assert.equal(body.units, 'kilometers');
    assert.equal(body.directions_type, 'none');

    const down = buildValhallaRequest({ start: START, end: END, avoid: avoid.slice(0, 1), avoidRadiusM: 120.2 });
    assert.equal(down.exclude_locations[0].radius, 120);
  });

  test('accepts exactly VALHALLA_MAX_AVOID (50) avoid points', () => {
    const body = buildValhallaRequest({ start: START, end: END, avoid: manyPoints(50), avoidRadiusM: 75 });
    assert.equal(body.exclude_locations.length, 50);
  });

  test('throws InputError (code INPUT) when avoid has more than VALHALLA_MAX_AVOID points', () => {
    assert.throws(
      () => buildValhallaRequest({ start: START, end: END, avoid: manyPoints(51), avoidRadiusM: 75 }),
      assertInputError,
    );
  });
});

describe('routing: parseValhallaResponse', () => {
  test('decodes the precision-6 leg shape to [lat, lon] points; distanceM = summary.length * 1000, durationS = summary.time', () => {
    const shape = [
      [33.749, -84.388],
      [33.7525, -84.3891],
      [33.7612, -84.3917],
      [33.7756, -84.3963],
    ];
    const route = parseValhallaResponse(valhallaResponse([shape], 3.217, 412.5));
    assertPointsClose(route.points, shape, 'points');
    assertClose(route.distanceM, 3217, 1e-9, 'distanceM');
    assert.equal(route.durationS, 412.5);
  });

  test('concatenates multiple legs and drops the duplicate joint point between legs', () => {
    const leg1 = [
      [33.749, -84.388],
      [33.75, -84.38],
      [33.752, -84.37],
    ];
    const leg2 = [
      [33.752, -84.37],
      [33.756, -84.365],
      [33.76, -84.36],
    ];
    const route = parseValhallaResponse(valhallaResponse([leg1, leg2], 2.5, 300));
    assertPointsClose(
      route.points,
      [leg1[0], leg1[1], leg1[2], leg2[1], leg2[2]],
      'joined points',
    );
    assertClose(route.distanceM, 2500, 1e-9, 'distanceM');
    assert.equal(route.durationS, 300);
  });

  test('throws UpstreamError("valhalla", ...) when the trip is missing or malformed', () => {
    const good = valhallaResponse([[[33.749, -84.388], [33.76, -84.39]]], 1.3, 100);
    const noLegs = structuredClone(good);
    delete noLegs.trip.legs;
    const noSummary = structuredClone(good);
    delete noSummary.trip.summary;
    const bad = {
      'null': null,
      'a string': 'Found route',
      'empty object': {},
      'trip null': { trip: null },
      'trip without legs': noLegs,
      'trip without summary': noSummary,
      'Valhalla error body': { error_code: 442, error: 'No path could be found for input', status_code: 400 },
    };
    for (const [label, json] of Object.entries(bad)) {
      assert.throws(() => parseValhallaResponse(json), assertUpstream, `input: ${label}`);
    }
  });
});

describe('routing: ValhallaRouter', () => {
  const req = {
    start: START,
    end: END,
    avoid: [{ lat: 33.7601, lon: -84.3902 }],
    avoidRadiusM: 75,
  };
  const shape = [
    [33.749, -84.388],
    [33.7612, -84.3917],
    [33.7756, -84.3963],
  ];

  test('is a Router named "valhalla" with maxAvoid 50', () => {
    const router = new ValhallaRouter({ fetch: fakeFetch(() => jsonResponse(valhallaResponse([shape], 3, 400))) });
    assert.equal(router.name, 'valhalla');
    assert.equal(router.maxAvoid, 50);
    assert.equal(typeof router.route, 'function');
  });

  test('POSTs the buildValhallaRequest body as JSON to the endpoint (default VALHALLA_ENDPOINT)', async () => {
    const fetchA = fakeFetch(() => jsonResponse(valhallaResponse([shape], 3, 400)));
    await new ValhallaRouter({ fetch: fetchA }).route(req);
    assert.equal(fetchA.calls.length, 1);
    assert.equal(fetchA.calls[0].url, VALHALLA_ENDPOINT);
    assert.equal(fetchA.calls[0].method, 'POST');
    assert.deepStrictEqual(JSON.parse(fetchA.calls[0].body), {
      locations: [
        { lat: START.lat, lon: START.lon },
        { lat: END.lat, lon: END.lon },
      ],
      costing: 'auto',
      units: 'kilometers',
      directions_type: 'none',
      exclude_locations: [{ lat: 33.7601, lon: -84.3902, radius: 75 }],
    });

    const fetchB = fakeFetch(() => jsonResponse(valhallaResponse([shape], 3, 400)));
    await new ValhallaRouter({ fetch: fetchB, endpoint: 'http://valhalla.test/route' }).route(req);
    assert.equal(fetchB.calls.length, 1);
    assert.equal(fetchB.calls[0].url, 'http://valhalla.test/route');
  });

  test('sends the User-Agent header (default USER_AGENT, or the userAgent option)', async () => {
    const fetchA = fakeFetch(() => jsonResponse(valhallaResponse([shape], 3, 400)));
    await new ValhallaRouter({ fetch: fetchA }).route(req);
    assert.equal(fetchA.calls[0].headers.get('user-agent'), USER_AGENT);

    const fetchB = fakeFetch(() => jsonResponse(valhallaResponse([shape], 3, 400)));
    await new ValhallaRouter({ fetch: fetchB, userAgent: 'acceptance-test/1.0 (test@example.com)' }).route(req);
    assert.equal(fetchB.calls[0].headers.get('user-agent'), 'acceptance-test/1.0 (test@example.com)');
  });

  test('resolves to the Route parsed from a 200 response', async () => {
    const fetch = fakeFetch(() => jsonResponse(valhallaResponse([shape], 3.4, 456)));
    const route = await new ValhallaRouter({ fetch }).route(req);
    assertPointsClose(route.points, shape, 'points');
    assertClose(route.distanceM, 3400, 1e-9, 'distanceM');
    assert.equal(route.durationS, 456);
  });

  test('rejects with NoRouteError (code NO_ROUTE) when Valhalla answers 400 with error_code 442 (no path)', async () => {
    const fetch = fakeFetch(() =>
      jsonResponse(
        { error_code: 442, error: 'No path could be found for input', status_code: 400, status: 'Bad Request' },
        400,
      ),
    );
    await assert.rejects(new ValhallaRouter({ fetch }).route(req), assertNoRoute);
  });

  test('rejects with NoRouteError (code NO_ROUTE) when Valhalla answers 400 with error_code 171 (no road near a location)', async () => {
    const fetch = fakeFetch(() =>
      jsonResponse(
        { error_code: 171, error: 'No suitable edges near location', status_code: 400, status: 'Bad Request' },
        400,
      ),
    );
    await assert.rejects(new ValhallaRouter({ fetch }).route(req), assertNoRoute);
  });

  test('rejects with UpstreamError("valhalla") on a 400 with any other error_code', async () => {
    const fetch = fakeFetch(() =>
      jsonResponse(
        { error_code: 154, error: 'Path distance exceeds the max distance limit', status_code: 400, status: 'Bad Request' },
        400,
      ),
    );
    await assert.rejects(new ValhallaRouter({ fetch }).route(req), assertUpstream);
  });

  test('rejects with UpstreamError("valhalla") on any other non-2xx status', async () => {
    for (const status of [404, 429, 500, 502, 503]) {
      const fetch = fakeFetch(() => new Response('<html>Service unavailable</html>', { status }));
      await assert.rejects(new ValhallaRouter({ fetch }).route(req), assertUpstream, `status ${status}`);
    }
    const fetch400Text = fakeFetch(() => new Response('Bad Request', { status: 400 }));
    await assert.rejects(new ValhallaRouter({ fetch: fetch400Text }).route(req), assertUpstream, '400 without JSON');
  });

  test('rejects with UpstreamError("valhalla") on network failure', async () => {
    const fetch = fakeFetch(() => {
      throw new TypeError('fetch failed');
    });
    await assert.rejects(new ValhallaRouter({ fetch }).route(req), assertUpstream);
  });

  test('rejects with UpstreamError("valhalla") when a 200 response is not valid JSON', async () => {
    const fetch = fakeFetch(() => new Response('<html>not json</html>', { status: 200 }));
    await assert.rejects(new ValhallaRouter({ fetch }).route(req), assertUpstream);
  });

  test('rejects with UpstreamError("valhalla") when a 200 response has no usable trip', async () => {
    const fetch = fakeFetch(() => jsonResponse({ unexpected: true }));
    await assert.rejects(new ValhallaRouter({ fetch }).route(req), assertUpstream);
  });

  test('rejects with InputError (code INPUT) when avoid has more than maxAvoid points', async () => {
    const fetch = fakeFetch(() => jsonResponse(valhallaResponse([shape], 3, 400)));
    await assert.rejects(
      new ValhallaRouter({ fetch }).route({ ...req, avoid: manyPoints(51) }),
      assertInputError,
    );
  });
});

// ---------------------------------------------------------------------------
// Stub

// Eastbound trip of about 3.7 km in central Atlanta: left of travel is north, right is south.
const EAST_START = { lat: 33.749, lon: -84.41 };
const EAST_END = { lat: 33.749, lon: -84.37 };
const EAST_MID = midpoint(EAST_START, EAST_END);
const RADIUS = 100;

describe('routing: stub constants', () => {
  test('STUB_SPEED_MPS is 40 km/h in m/s', () => {
    assertClose(STUB_SPEED_MPS, 40_000 / 3600, 1e-12, 'STUB_SPEED_MPS');
  });

  test('STUB_OFFSETS_M is [500, 1000, 2000, 4000], nearest first', () => {
    assert.deepStrictEqual(STUB_OFFSETS_M, [500, 1000, 2000, 4000]);
  });
});

describe('routing: StubRouter', () => {
  test('is a Router named "stub" with maxAvoid 50', () => {
    const router = new StubRouter();
    assert.equal(router.name, 'stub');
    assert.equal(router.maxAvoid, 50);
    assert.equal(typeof router.route, 'function');
  });

  test('returns the straight line [start, end] when there are no avoid points', async () => {
    const route = await new StubRouter().route({ start: EAST_START, end: EAST_END, avoid: [], avoidRadiusM: RADIUS });
    assert.deepStrictEqual(route.points, [
      [EAST_START.lat, EAST_START.lon],
      [EAST_END.lat, EAST_END.lon],
    ]);
  });

  test('returns the straight line when every avoid point is farther than avoidRadiusM from it', async () => {
    const avoid = [
      fromXY(EAST_MID, { x: 0, y: 120 }), // 120 m north of the line, radius 100
      fromXY(EAST_MID, { x: 800, y: -300 }),
      { lat: 33.80, lon: -84.30 },
    ];
    const route = await new StubRouter().route({ start: EAST_START, end: EAST_END, avoid, avoidRadiusM: RADIUS });
    assert.deepStrictEqual(route.points, [
      [EAST_START.lat, EAST_START.lon],
      [EAST_END.lat, EAST_END.lon],
    ]);
  });

  test('leaves the straight line when an avoid point is within avoidRadiusM of it (not only on it)', async () => {
    const avoid = [fromXY(EAST_MID, { x: 300, y: 80 })]; // 80 m north of the line, radius 100
    const route = await new StubRouter().route({ start: EAST_START, end: EAST_END, avoid, avoidRadiusM: RADIUS });
    assert.equal(route.points.length, 3, `expected a dog-leg, got ${JSON.stringify(route.points)}`);
  });

  test('dog-leg is [start, waypoint, end] with the waypoint at the start-end midpoint moved perpendicular by 500 m', async () => {
    // Diagonal (north-east) trip so "perpendicular" is not just a latitude shift.
    const start = { lat: 33.74, lon: -84.40 };
    const end = { lat: 33.76, lon: -84.375 };
    const avoid = [midpoint(start, end)];
    const route = await new StubRouter().route({ start, end, avoid, avoidRadiusM: RADIUS });
    assert.equal(route.points.length, 3);
    assert.deepStrictEqual(route.points[0], [start.lat, start.lon]);
    assert.deepStrictEqual(route.points[2], [end.lat, end.lon]);
    const wp = route.points[1];
    assertWaypoint(start, end, wp, { side: 'left', offsetM: 500 });
    // perpendicular through the midpoint means equally far from start and end
    const dStart = haversine(start, { lat: wp[0], lon: wp[1] });
    const dEnd = haversine(end, { lat: wp[0], lon: wp[1] });
    assert.ok(Math.abs(dStart - dEnd) <= 0.02 * dStart, `waypoint should be equidistant from start (${dStart}) and end (${dEnd})`);
  });

  test('tries dog-legs at each STUB_OFFSETS_M value nearest first, left side then right side, and returns the first clear one', async () => {
    const router = new StubRouter();
    for (let k = 0; k < CANDIDATES.length; k++) {
      // Block the straight line and the first k candidates; candidate k is the first clear one.
      const avoid = [EAST_MID];
      for (let j = 0; j < k; j++) {
        avoid.push(expectedWaypoint(EAST_START, EAST_END, CANDIDATES[j].side, CANDIDATES[j].offsetM));
      }
      const route = await router.route({ start: EAST_START, end: EAST_END, avoid, avoidRadiusM: RADIUS });
      const label = `with ${k} candidate(s) blocked:`;
      assert.equal(route.points.length, 3, `${label} expected a dog-leg`);
      assertWaypoint(EAST_START, EAST_END, route.points[1], CANDIDATES[k], label);
    }
  });

  test('when no dog-leg is clear, returns the one with the fewest avoid points within avoidRadiusM', async () => {
    // The start point is within the radius of every candidate (1 hit each);
    // the 500 m waypoints add a second hit to both 500 m dog-legs, so the left 1000 m one wins.
    const avoid = [
      { ...EAST_START },
      expectedWaypoint(EAST_START, EAST_END, 'left', 500),
      expectedWaypoint(EAST_START, EAST_END, 'right', 500),
    ];
    const route = await new StubRouter().route({ start: EAST_START, end: EAST_END, avoid, avoidRadiusM: RADIUS });
    assert.equal(route.points.length, 3);
    assertWaypoint(EAST_START, EAST_END, route.points[1], { side: 'left', offsetM: 1000 });
  });

  test('when no dog-leg is clear and several tie, the first in order wins (and it still resolves, never NoRouteError)', async () => {
    // Every candidate waypoint is blocked once and the straight line is blocked at the midpoint:
    // all dog-legs tie at 1 hit, so the left 500 m one (first) wins, not the straight line.
    const avoid = [EAST_MID, ...CANDIDATES.map((c) => expectedWaypoint(EAST_START, EAST_END, c.side, c.offsetM))];
    const route = await new StubRouter().route({ start: EAST_START, end: EAST_END, avoid, avoidRadiusM: RADIUS });
    assert.equal(route.points.length, 3, `expected a dog-leg, got ${JSON.stringify(route.points)}`);
    assert.deepStrictEqual(route.points[0], [EAST_START.lat, EAST_START.lon]);
    assert.deepStrictEqual(route.points[2], [EAST_END.lat, EAST_END.lon]);
    assertWaypoint(EAST_START, EAST_END, route.points[1], { side: 'left', offsetM: 500 });
  });

  test('distanceM is the haversine length of the returned points', async () => {
    const router = new StubRouter();
    const straight = await router.route({ start: EAST_START, end: EAST_END, avoid: [], avoidRadiusM: RADIUS });
    assertClose(straight.distanceM, lineLength(straight.points), 0.01, 'straight distanceM');
    assertClose(straight.distanceM, haversine(EAST_START, EAST_END), 0.01, 'straight distanceM vs start-end');

    const dogLeg = await router.route({ start: EAST_START, end: EAST_END, avoid: [EAST_MID], avoidRadiusM: RADIUS });
    assert.equal(dogLeg.points.length, 3);
    assertClose(dogLeg.distanceM, lineLength(dogLeg.points), 0.01, 'dog-leg distanceM');
    assert.ok(dogLeg.distanceM > straight.distanceM, 'a dog-leg is longer than the straight line');
  });

  test('durationS is distanceM / STUB_SPEED_MPS', async () => {
    const router = new StubRouter();
    for (const avoid of [[], [EAST_MID]]) {
      const route = await router.route({ start: EAST_START, end: EAST_END, avoid, avoidRadiusM: RADIUS });
      assertClose(route.durationS, route.distanceM / STUB_SPEED_MPS, 1e-9, `durationS (avoid ${avoid.length})`);
    }
  });

  test('is deterministic: the same request gives the same route', async () => {
    const req = { start: EAST_START, end: EAST_END, avoid: [EAST_MID, { lat: 33.7535, lon: -84.39 }], avoidRadiusM: RADIUS };
    const a = await new StubRouter().route(req);
    const b = await new StubRouter().route(req);
    const c = await new StubRouter().route(structuredClone(req));
    assert.deepStrictEqual(b, a);
    assert.deepStrictEqual(c, a);
  });

  test('accepts exactly maxAvoid (50) avoid points', async () => {
    const route = await new StubRouter().route({ start: EAST_START, end: EAST_END, avoid: manyPoints(50), avoidRadiusM: RADIUS });
    assert.ok(route.points.length >= 2);
  });

  test('rejects with InputError (code INPUT) when avoid has more than maxAvoid points', async () => {
    await assert.rejects(
      new StubRouter().route({ start: EAST_START, end: EAST_END, avoid: manyPoints(51), avoidRadiusM: RADIUS }),
      assertInputError,
    );
  });
});
