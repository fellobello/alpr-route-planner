// Acceptance tests for src/planner.js, written from .hub/spec.md and the interface JSDoc in
// src/planner.js, src/types.js and src/geo.js only. No network: the camera source and the
// router are in-test fakes.
//
// Geometry used throughout (central Atlanta, all routes start at START and end at END):
//   - the fastest route runs due east along lat 33.75, with a vertex every 0.01 degrees of lon;
//   - a "detour" leaves START due north (or south), runs east at lat 33.75 + offset and comes
//     back down to END. Offsets of 0.004 degrees or more are >= 440 m from any other line.
//   - cameras sit exactly on route vertices (distance 0) or hundreds of meters away, so hit
//     detection never depends on how precise geo.js is. The one exception is the buffer test,
//     which puts a camera 50 m from the line and plans with 75 m and 30 m buffers.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { planRoutes, validatePlanRequest } from '../../src/planner.js';
import {
  CORRIDOR_MARGIN_M,
  DEFAULT_BUFFER_M,
  InputError,
  MAX_AVOID_ITERATIONS,
  MAX_BUFFER_M,
  MIN_BUFFER_M,
  NoRouteError,
  TripTooLongError,
  UpstreamError,
} from '../../src/types.js';

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const LAT0 = 33.75;
const START = Object.freeze({ lat: LAT0, lon: -84.40 });
const END = Object.freeze({ lat: LAT0, lon: -84.36 });
const VERTEX_LONS = [-84.40, -84.39, -84.38, -84.37, -84.36];

/** Independent haversine (same Earth radius as geo.js) for checking bbox margins. */
function distM(a, b) {
  const R = 6_371_008.8;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** @returns {import('../../src/types.js').Camera} */
function cam(id, lat, lon, isFlock = false) {
  return {
    id,
    lat,
    lon,
    isFlock,
    manufacturer: isFlock ? 'Flock Safety' : null,
    operator: null,
    direction: null,
    source: 'sample',
  };
}

/** The no-avoidance route: due east along LAT0. */
function straightRoute(durationS = 300) {
  return {
    points: VERTEX_LONS.map((lon) => [LAT0, lon]),
    distanceM: 3700,
    durationS,
  };
}

/** A route that goes north (offset > 0) or south, runs east at LAT0 + offset, then back to END. */
function detourRoute(offsetDeg, durationS = 400) {
  const lat = LAT0 + offsetDeg;
  return {
    points: [[START.lat, START.lon], ...VERTEX_LONS.map((lon) => [lat, lon]), [END.lat, END.lon]],
    distanceM: 3700 + 2 * Math.abs(offsetDeg) * 111_195,
    durationS,
  };
}

/**
 * Fake CameraSource: returns the cameras inside the bbox (inclusive), like the real contract,
 * and records a copy of every bbox it is asked for.
 */
function fakeSource(cameras) {
  const calls = [];
  return {
    name: 'fake',
    calls,
    async getCameras(bbox) {
      calls.push({ ...bbox });
      return cameras
        .filter(
          (c) =>
            c.lat >= bbox.south && c.lat <= bbox.north && c.lon >= bbox.west && c.lon <= bbox.east,
        )
        .map((c) => ({ ...c }));
    },
  };
}

/** Fake CameraSource that always fails. */
function failingSource(err) {
  const calls = [];
  return {
    name: 'fake',
    calls,
    async getCameras(bbox) {
      calls.push({ ...bbox });
      throw err;
    },
  };
}

/**
 * Fake Router. Call n (0-based) answers with responses[n]: a Route (returned as a fresh copy)
 * or an Error (thrown). Records a snapshot of every request at call time.
 */
function fakeRouter(responses, { maxAvoid = 50 } = {}) {
  const calls = [];
  return {
    name: 'fake',
    maxAvoid,
    calls,
    async route(req) {
      calls.push(structuredClone(req));
      const n = calls.length - 1;
      if (n >= responses.length) {
        throw new Error(`fake router: unexpected call #${n + 1} (only ${responses.length} scripted)`);
      }
      const r = responses[n];
      if (r instanceof Error) throw r;
      return structuredClone(r);
    },
  };
}

/** Avoid points as plain {lat, lon} (the planner may pass Camera objects, which are LatLngs). */
function avoidOf(call) {
  return call.avoid.map((p) => ({ lat: p.lat, lon: p.lon }));
}

function latLonOf(c) {
  return { lat: c.lat, lon: c.lon };
}

function sortedIds(cameras) {
  return cameras.map((c) => c.id).sort();
}

// Note strings from the planRoutes JSDoc. "<n> camera(s)" is accepted either literally or
// pluralized ("1 camera", "2 cameras"): decision planner-tests.1. Details the spec leaves open
// (listed in decision planner-tests.2) are deliberately not asserted.
function camerasWord(n) {
  return n === 1 ? '(?:camera|camera\\(s\\))' : '(?:cameras|camera\\(s\\))';
}
function unavoidableNote(n) {
  return new RegExp(`^${n} ${camerasWord(n)} next to your start or end can't be avoided\\.$`);
}
function stillPassesNote(n) {
  return new RegExp(`^The avoiding route still passes ${n} ${camerasWord(n)}\\.$`);
}
const TOO_MANY_NOTE = 'Too many cameras to block them all; showing the best route found.';
const NO_OTHER_ROUTE_NOTE = 'No other route was found.';

/** Assert notes match the expected list exactly, in order (strings or RegExps). */
function assertNotes(actual, expected) {
  const shown = JSON.stringify(actual);
  assert.ok(Array.isArray(actual), `notes should be an array, got ${shown}`);
  assert.equal(actual.length, expected.length, `wrong number of notes: ${shown}`);
  expected.forEach((want, i) => {
    if (want instanceof RegExp) {
      assert.match(actual[i], want, `note ${i} is wrong: ${shown}`);
    } else {
      assert.equal(actual[i], want, `note ${i} is wrong: ${shown}`);
    }
  });
}

function assertInputErrorCode(fn, label) {
  assert.throws(
    fn,
    (err) => err instanceof InputError && err.code === 'INPUT',
    `${label}: expected InputError with code INPUT`,
  );
}

// ---------------------------------------------------------------------------------------------
// validatePlanRequest
// ---------------------------------------------------------------------------------------------

describe('validatePlanRequest', () => {
  test('returns {start, end, bufferM} with bufferM defaulting to DEFAULT_BUFFER_M (75)', () => {
    const out = validatePlanRequest({ start: { lat: 33.75, lon: -84.4 }, end: { lat: 33.76, lon: -84.38 } });
    assert.deepEqual(out, {
      start: { lat: 33.75, lon: -84.4 },
      end: { lat: 33.76, lon: -84.38 },
      bufferM: DEFAULT_BUFFER_M,
    });
    assert.equal(DEFAULT_BUFFER_M, 75);
  });

  test('keeps a valid bufferM, including the exact limits MIN_BUFFER_M (15) and MAX_BUFFER_M (300)', () => {
    const base = { start: { lat: 33.75, lon: -84.4 }, end: { lat: 33.76, lon: -84.38 } };
    for (const bufferM of [MIN_BUFFER_M, 120, MAX_BUFFER_M]) {
      assert.equal(validatePlanRequest({ ...base, bufferM }).bufferM, bufferM, `bufferM ${bufferM}`);
    }
  });

  test('drops extra fields from the request', () => {
    const out = validatePlanRequest({
      start: { lat: 33.75, lon: -84.4 },
      end: { lat: 33.76, lon: -84.38 },
      bufferM: 100,
      avoid: [{ lat: 1, lon: 2 }],
      mode: 'bicycle',
    });
    assert.deepEqual(out, {
      start: { lat: 33.75, lon: -84.4 },
      end: { lat: 33.76, lon: -84.38 },
      bufferM: 100,
    });
  });

  test('accepts coordinates on the exact range limits (lat +/-90, lon +/-180)', () => {
    // Both points of each pair are the same physical place, so the trip is 0 km.
    assert.doesNotThrow(() => validatePlanRequest({ start: { lat: 90, lon: 0 }, end: { lat: 90, lon: 10 } }));
    assert.doesNotThrow(() => validatePlanRequest({ start: { lat: -90, lon: 0 }, end: { lat: -90, lon: -10 } }));
    assert.doesNotThrow(() => validatePlanRequest({ start: { lat: 0, lon: 180 }, end: { lat: 0, lon: -180 } }));
  });

  test('rejects a missing or non-object request with InputError (code INPUT)', () => {
    for (const req of [undefined, null, 'start', 42, [], {}]) {
      assertInputErrorCode(() => validatePlanRequest(req), `request ${JSON.stringify(req)}`);
    }
  });

  test('rejects a bad start or end (missing, not {lat, lon}, non-finite, out of range) with InputError (code INPUT)', () => {
    const ok = { lat: 33.75, lon: -84.4 };
    const bad = [
      undefined,
      null,
      [33.75, -84.4],
      { lat: 33.75 },
      { lon: -84.4 },
      { lat: 'north', lon: -84.4 },
      { lat: NaN, lon: -84.4 },
      { lat: 33.75, lon: Infinity },
      { lat: 90.0001, lon: -84.4 },
      { lat: -91, lon: -84.4 },
      { lat: 33.75, lon: 180.5 },
      { lat: 33.75, lon: -181 },
    ];
    for (const p of bad) {
      assertInputErrorCode(() => validatePlanRequest({ start: p, end: ok }), `start ${JSON.stringify(p)}`);
      assertInputErrorCode(() => validatePlanRequest({ start: ok, end: p }), `end ${JSON.stringify(p)}`);
    }
  });

  test('rejects bufferM that is non-finite or outside [15, 300] with InputError (code INPUT)', () => {
    const base = { start: { lat: 33.75, lon: -84.4 }, end: { lat: 33.76, lon: -84.38 } };
    for (const bufferM of [MIN_BUFFER_M - 0.01, MAX_BUFFER_M + 0.01, 0, -75, NaN, Infinity, 'wide']) {
      assertInputErrorCode(() => validatePlanRequest({ ...base, bufferM }), `bufferM ${String(bufferM)}`);
    }
  });

  test('rejects a straight-line trip over MAX_TRIP_M (50 km) with TripTooLongError (code TRIP_TOO_LONG)', () => {
    // 0.46 degrees of latitude is about 51.1 km.
    assert.throws(
      () => validatePlanRequest({ start: { lat: 33.5, lon: -84.39 }, end: { lat: 33.96, lon: -84.39 } }),
      (err) => err instanceof TripTooLongError && err instanceof InputError && err.code === 'TRIP_TOO_LONG',
    );
  });

  test('accepts a straight-line trip just under MAX_TRIP_M (about 48.9 km)', () => {
    const out = validatePlanRequest({ start: { lat: 33.5, lon: -84.39 }, end: { lat: 33.94, lon: -84.39 } });
    assert.deepEqual(out.end, { lat: 33.94, lon: -84.39 });
  });
});

// ---------------------------------------------------------------------------------------------
// planRoutes: inputs, outputs and error propagation
// ---------------------------------------------------------------------------------------------

describe('planRoutes: request handling and errors', () => {
  test('a request that fails validation rejects with that InputError and calls neither router nor source', async () => {
    const router = fakeRouter([straightRoute()]);
    const cameraSource = fakeSource([]);
    await assert.rejects(
      planRoutes({ start: START, end: END, bufferM: 5 }, { cameraSource, router }),
      (err) => err instanceof InputError && err.code === 'INPUT',
    );
    await assert.rejects(
      planRoutes({ start: { lat: 33.5, lon: -84.39 }, end: { lat: 33.96, lon: -84.39 } }, { cameraSource, router }),
      (err) => err instanceof TripTooLongError && err.code === 'TRIP_TOO_LONG',
    );
    assert.equal(router.calls.length, 0, 'router must not be called');
    assert.equal(cameraSource.calls.length, 0, 'camera source must not be called');
  });

  test('a NoRouteError from the fastest route call propagates unchanged', async () => {
    const boom = new NoRouteError('no path between the points');
    const router = fakeRouter([boom]);
    await assert.rejects(
      planRoutes({ start: START, end: END }, { cameraSource: fakeSource([]), router }),
      (err) => err === boom,
    );
  });

  test('an UpstreamError from the fastest route call propagates unchanged', async () => {
    const boom = new UpstreamError('valhalla', 'HTTP 503');
    const router = fakeRouter([boom]);
    await assert.rejects(
      planRoutes({ start: START, end: END }, { cameraSource: fakeSource([]), router }),
      (err) => err === boom,
    );
  });

  test('an error from getCameras propagates unchanged', async () => {
    const boom = new UpstreamError('overpass', 'HTTP 504');
    const router = fakeRouter([straightRoute()]);
    await assert.rejects(
      planRoutes({ start: START, end: END }, { cameraSource: failingSource(boom), router }),
      (err) => err === boom,
    );
  });

  test('the first router call is {start, end, avoid: [], avoidRadiusM: bufferM} with the validated points', async () => {
    const router = fakeRouter([straightRoute()]);
    await planRoutes(
      { start: { ...START }, end: { ...END }, bufferM: 120, extra: true },
      { cameraSource: fakeSource([]), router },
    );
    assert.deepEqual(router.calls[0], {
      start: { lat: START.lat, lon: START.lon },
      end: { lat: END.lat, lon: END.lon },
      avoid: [],
      avoidRadiusM: 120,
    });
  });

  test('cameras are fetched for bboxAround([start, end, ...fastest.points], CORRIDOR_MARGIN_M)', async () => {
    // The fastest route bulges north to 33.77, beyond both start and end.
    const fastest = { points: [[LAT0, -84.40], [33.77, -84.38], [LAT0, -84.36]], distanceM: 5000, durationS: 400 };
    const cameraSource = fakeSource([]);
    await planRoutes({ start: START, end: END }, { cameraSource, router: fakeRouter([fastest]) });

    assert.ok(cameraSource.calls.length >= 1, 'getCameras was not called');
    const area = cameraSource.calls[0];
    for (const k of ['south', 'west', 'north', 'east']) {
      assert.equal(typeof area[k], 'number', `bbox.${k} should be a number`);
    }
    const margins = {
      south: distM({ lat: LAT0, lon: -84.38 }, { lat: area.south, lon: -84.38 }),
      north: distM({ lat: 33.77, lon: -84.38 }, { lat: area.north, lon: -84.38 }),
      west: distM({ lat: 33.76, lon: -84.40 }, { lat: 33.76, lon: area.west }),
      east: distM({ lat: 33.76, lon: -84.36 }, { lat: 33.76, lon: area.east }),
    };
    assert.ok(area.south < LAT0 && area.north > 33.77, `bbox must contain every point: ${JSON.stringify(area)}`);
    assert.ok(area.west < -84.40 && area.east > -84.36, `bbox must contain every point: ${JSON.stringify(area)}`);
    for (const [side, m] of Object.entries(margins)) {
      assert.ok(
        Math.abs(m - CORRIDOR_MARGIN_M) <= CORRIDOR_MARGIN_M * 0.03,
        `${side} margin should be about ${CORRIDOR_MARGIN_M} m, got ${m.toFixed(1)} m (${JSON.stringify(area)})`,
      );
    }
  });

  test('returns every documented RoutePlan field, with bufferM set to the buffer actually used', async () => {
    const plan = await planRoutes(
      { start: START, end: END },
      { cameraSource: fakeSource([]), router: fakeRouter([straightRoute()]) },
    );
    for (const k of ['fastest', 'avoiding', 'cameras', 'bufferM', 'iterations', 'notes']) {
      assert.ok(k in plan, `RoutePlan is missing ${k}`);
    }
    assert.equal(plan.bufferM, DEFAULT_BUFFER_M);

    const plan2 = await planRoutes(
      { start: START, end: END, bufferM: 200 },
      { cameraSource: fakeSource([]), router: fakeRouter([straightRoute()]) },
    );
    assert.equal(plan2.bufferM, 200);
  });

  test('fastest is the router route with cameraIds of cameras on it, ordered along the route (not by id or source order)', async () => {
    const fastest = straightRoute();
    // Source order and id order are both the reverse of route order.
    const cameras = [cam('cam-1', LAT0, -84.37, true), cam('cam-2', LAT0, -84.39)];
    const router = fakeRouter([fastest, detourRoute(0.01)]);
    const plan = await planRoutes({ start: START, end: END }, { cameraSource: fakeSource(cameras), router });
    assert.deepEqual(plan.fastest.route, fastest);
    assert.deepEqual(plan.fastest.cameraIds, ['cam-2', 'cam-1']);
  });

  test('cameras lists every camera fetched for the trip area, including ones on no route', async () => {
    const onRoute = cam('on-route', LAT0, -84.39);
    const offRoute = cam('off-route', 33.74, -84.385); // ~1.1 km south of the route, inside the area
    const farAway = cam('far-away', 34.2, -83.9); // outside the trip area
    const router = fakeRouter([straightRoute(), detourRoute(0.01)]);
    const plan = await planRoutes(
      { start: START, end: END },
      { cameraSource: fakeSource([onRoute, offRoute, farAway]), router },
    );
    assert.deepEqual(sortedIds(plan.cameras), ['off-route', 'on-route']);
    assert.deepEqual(plan.cameras.find((c) => c.id === 'off-route'), offRoute);
  });
});

// ---------------------------------------------------------------------------------------------
// planRoutes: the avoidance loop
// ---------------------------------------------------------------------------------------------

describe('planRoutes: avoidance', () => {
  test('when the fastest route passes no camera: one router call, iterations 0, avoiding deep-equals fastest, no notes', async () => {
    const router = fakeRouter([straightRoute()]);
    const plan = await planRoutes(
      { start: START, end: END },
      { cameraSource: fakeSource([cam('elsewhere', 33.74, -84.385)]), router },
    );
    assert.equal(router.calls.length, 1);
    assert.equal(plan.iterations, 0);
    assert.deepEqual(plan.fastest.cameraIds, []);
    assert.deepEqual(plan.avoiding, plan.fastest);
    assertNotes(plan.notes, []);
  });

  test('blocks the cameras the fastest route passes (in route order) and picks the camera-free reroute', async () => {
    const a = cam('a', LAT0, -84.39);
    const b = cam('b', LAT0, -84.37);
    const reroute = detourRoute(0.01, 420);
    const router = fakeRouter([straightRoute(300), reroute]);
    const plan = await planRoutes({ start: START, end: END }, { cameraSource: fakeSource([b, a]), router });

    assert.equal(router.calls.length, 2);
    assert.deepEqual(router.calls[1].start, { lat: START.lat, lon: START.lon });
    assert.deepEqual(router.calls[1].end, { lat: END.lat, lon: END.lon });
    assert.deepEqual(avoidOf(router.calls[1]), [latLonOf(a), latLonOf(b)]);
    assert.equal(plan.iterations, 1);
    assert.deepEqual(plan.fastest.cameraIds, ['a', 'b']);
    assert.deepEqual(plan.avoiding.route, reroute);
    assert.deepEqual(plan.avoiding.cameraIds, []);
    assertNotes(plan.notes, []);
  });

  test('every router call uses avoidRadiusM equal to bufferM', async () => {
    const router = fakeRouter([straightRoute(), detourRoute(0.01)]);
    await planRoutes(
      { start: START, end: END, bufferM: 120 },
      { cameraSource: fakeSource([cam('a', LAT0, -84.39)]), router },
    );
    assert.equal(router.calls.length, 2);
    for (const call of router.calls) assert.equal(call.avoidRadiusM, 120);
  });

  test('camera hits use bufferM: a camera 50 m from the route counts at 75 m but not at 30 m', async () => {
    const near = cam('near', LAT0 + 0.00045, -84.38); // ~50 m north of the line, ~1.8 km from start and end

    const wide = await planRoutes(
      { start: START, end: END, bufferM: 75 },
      { cameraSource: fakeSource([near]), router: fakeRouter([straightRoute(), detourRoute(0.01)]) },
    );
    assert.deepEqual(wide.fastest.cameraIds, ['near']);

    const narrowRouter = fakeRouter([straightRoute(), detourRoute(0.01)]);
    const narrow = await planRoutes(
      { start: START, end: END, bufferM: 30 },
      { cameraSource: fakeSource([near]), router: narrowRouter },
    );
    assert.deepEqual(narrow.fastest.cameraIds, []);
    assert.equal(narrowRouter.calls.length, 1);
    assert.equal(narrow.iterations, 0);
  });

  test('blocked accumulates: each new candidate adds its cameras to the earlier ones', async () => {
    const a = cam('a', LAT0, -84.39);
    const c = cam('c', LAT0 + 0.01, -84.38); // on the north detour
    const north = detourRoute(0.01, 400);
    const south = detourRoute(-0.01, 450);
    const router = fakeRouter([straightRoute(), north, south]);
    const plan = await planRoutes({ start: START, end: END }, { cameraSource: fakeSource([a, c]), router });

    assert.equal(router.calls.length, 3);
    assert.deepEqual(avoidOf(router.calls[1]), [latLonOf(a)]);
    assert.deepEqual(avoidOf(router.calls[2]), [latLonOf(a), latLonOf(c)]);
    assert.equal(plan.iterations, 2);
    assert.deepEqual(plan.avoiding.route, south);
    assert.deepEqual(plan.avoiding.cameraIds, []);
  });

  // MAX_AVOID_ITERATIONS candidates (plus spares), each passing exactly one new camera.
  function endlessCamerasScenario() {
    const fastestCams = [cam('a', LAT0, -84.39), cam('b', LAT0, -84.37)];
    const candidates = [];
    const candidateCams = [];
    for (let k = 1; k <= MAX_AVOID_ITERATIONS + 2; k++) {
      const offset = (k % 2 === 1 ? 1 : -1) * 0.004 * Math.ceil(k / 2);
      // Candidate 2 is the fastest of the one-camera candidates.
      candidates.push(detourRoute(offset, k === 2 ? 450 : 500 + k));
      candidateCams.push(cam(`k${k}`, LAT0 + offset, -84.38));
    }
    return {
      fastest: straightRoute(300),
      candidates,
      cameras: [...fastestCams, ...candidateCams],
    };
  }

  test('makes at most MAX_AVOID_ITERATIONS (4) avoid calls and reports them in iterations', async () => {
    const s = endlessCamerasScenario();
    const router = fakeRouter([s.fastest, ...s.candidates]);
    const plan = await planRoutes({ start: START, end: END }, { cameraSource: fakeSource(s.cameras), router });
    assert.equal(MAX_AVOID_ITERATIONS, 4);
    assert.equal(router.calls.length, 1 + MAX_AVOID_ITERATIONS);
    assert.equal(plan.iterations, MAX_AVOID_ITERATIONS);
  });

  test('avoiding is the candidate with the fewest cameras, ties going to the shorter durationS', async () => {
    const s = endlessCamerasScenario();
    const router = fakeRouter([s.fastest, ...s.candidates]);
    const plan = await planRoutes({ start: START, end: END }, { cameraSource: fakeSource(s.cameras), router });
    // fastest passes 2 cameras; every candidate passes 1; candidate 2 has the shortest duration.
    assert.deepEqual(plan.avoiding.route, s.candidates[1]);
    assert.deepEqual(plan.avoiding.cameraIds, ['k2']);
    assert.ok(plan.notes.some((n) => stillPassesNote(1).test(n)), `notes: ${JSON.stringify(plan.notes)}`);
  });

  test('never sends more than router.maxAvoid avoid points, keeping the first ones in route order', async () => {
    const a = cam('a', LAT0, -84.39);
    const b = cam('b', LAT0, -84.38);
    const c = cam('c', LAT0, -84.37);
    const router = fakeRouter([straightRoute(), detourRoute(0.01), detourRoute(-0.01)], { maxAvoid: 2 });
    await planRoutes({ start: START, end: END }, { cameraSource: fakeSource([c, b, a]), router });
    assert.ok(router.calls.length >= 2, 'expected an avoid call');
    for (const call of router.calls) {
      assert.ok(call.avoid.length <= 2, `avoid has ${call.avoid.length} points, maxAvoid is 2`);
    }
    assert.deepEqual(avoidOf(router.calls[1]), [latLonOf(a), latLonOf(b)]);
  });

  test('stops when the maxAvoid cap stops blocked from growing, with the "Too many cameras" note', async () => {
    const a = cam('a', LAT0, -84.39);
    const b = cam('b', LAT0, -84.37);
    const c = cam('c', LAT0 + 0.01, -84.38); // on the north detour
    const north = detourRoute(0.01, 400);
    const router = fakeRouter([straightRoute(300), north, detourRoute(-0.01)], { maxAvoid: 2 });
    const plan = await planRoutes({ start: START, end: END }, { cameraSource: fakeSource([a, b, c]), router });

    assert.equal(router.calls.length, 2, 'blocked is full after the first avoid call, so no third call');
    assert.equal(plan.iterations, 1);
    assert.deepEqual(plan.avoiding.route, north);
    assert.deepEqual(plan.avoiding.cameraIds, ['c']);
    assertNotes(plan.notes, [stillPassesNote(1), TOO_MANY_NOTE]);
  });

  test('a NoRouteError on an avoid call stops the search, keeps fastest as avoiding, and adds "No other route was found."', async () => {
    const a = cam('a', LAT0, -84.39);
    const b = cam('b', LAT0, -84.37);
    const fastest = straightRoute(300);
    const router = fakeRouter([fastest, new NoRouteError('blocked in'), detourRoute(0.01)]);
    const plan = await planRoutes({ start: START, end: END }, { cameraSource: fakeSource([a, b]), router });

    assert.equal(router.calls.length, 2);
    assert.deepEqual(plan.avoiding.route, fastest);
    assert.deepEqual(plan.avoiding.cameraIds, ['a', 'b']);
    assertNotes(plan.notes, [stillPassesNote(2), NO_OTHER_ROUTE_NOTE]);
  });
});

// ---------------------------------------------------------------------------------------------
// planRoutes: cameras next to start or end
// ---------------------------------------------------------------------------------------------

describe('planRoutes: unavoidable cameras', () => {
  // ~18.5 m from START / END, on the route line; well inside the 75 m default buffer.
  const nearStart = cam('near-start', LAT0, -84.3998);
  const nearEnd = cam('near-end', LAT0, -84.3602);

  test('cameras within bufferM of start or end are never put in avoid', async () => {
    const mid = cam('mid', LAT0, -84.38);
    const north = detourRoute(0.01);
    const router = fakeRouter([straightRoute(), north, detourRoute(-0.01)]);
    const plan = await planRoutes(
      { start: START, end: END },
      { cameraSource: fakeSource([nearEnd, mid, nearStart]), router },
    );

    assert.deepEqual(plan.fastest.cameraIds, ['near-start', 'mid', 'near-end']);
    assert.ok(router.calls.length >= 2, 'expected an avoid call for the mid-route camera');
    assert.deepEqual(avoidOf(router.calls[1]), [latLonOf(mid)]);
    for (const call of router.calls) {
      for (const p of call.avoid) {
        assert.ok(distM(p, START) > 75 && distM(p, END) > 75, `unavoidable camera in avoid: ${JSON.stringify(p)}`);
      }
    }
    // The north detour still passes both end cameras, but they can't be avoided, so the search stops.
    assert.equal(router.calls.length, 2);
    assert.deepEqual(plan.avoiding.route, north);
    assert.match(plan.notes[0] ?? '', unavoidableNote(2), `notes: ${JSON.stringify(plan.notes)}`);
  });

  test('when only unavoidable cameras are on the fastest route: no avoid calls, iterations 0, unavoidable note first', async () => {
    const router = fakeRouter([straightRoute(), detourRoute(0.01)]);
    const plan = await planRoutes({ start: START, end: END }, { cameraSource: fakeSource([nearStart]), router });

    assert.equal(router.calls.length, 1);
    assert.equal(plan.iterations, 0);
    assert.deepEqual(plan.fastest.cameraIds, ['near-start']);
    assert.deepEqual(plan.avoiding, plan.fastest);
    assert.match(plan.notes[0] ?? '', unavoidableNote(1), `notes: ${JSON.stringify(plan.notes)}`);
    assert.ok(!plan.notes.includes(TOO_MANY_NOTE) && !plan.notes.includes(NO_OTHER_ROUTE_NOTE));
  });

  test('notes come in the documented order: unavoidable, still passes, too many', async () => {
    const a = cam('a', LAT0, -84.39);
    const b = cam('b', LAT0, -84.37);
    const c = cam('c', LAT0 + 0.01, -84.38);
    const router = fakeRouter([straightRoute(), detourRoute(0.01), detourRoute(-0.01)], { maxAvoid: 2 });
    const plan = await planRoutes(
      { start: START, end: END },
      { cameraSource: fakeSource([nearStart, a, b, c]), router },
    );
    // The north detour passes near-start (unavoidable) and c (avoidable). Whether "still passes"
    // counts the unavoidable camera is not specified, so 1 or 2 is accepted.
    assert.equal(plan.notes.length, 3, `notes: ${JSON.stringify(plan.notes)}`);
    assert.match(plan.notes[0], unavoidableNote(1));
    assert.ok(
      stillPassesNote(1).test(plan.notes[1]) || stillPassesNote(2).test(plan.notes[1]),
      `note 1 should be "The avoiding route still passes ...": ${JSON.stringify(plan.notes)}`,
    );
    assert.equal(plan.notes[2], TOO_MANY_NOTE);
  });
});

// ---------------------------------------------------------------------------------------------
// planRoutes: candidates that leave the trip area
// ---------------------------------------------------------------------------------------------

describe('planRoutes: growing the trip area', () => {
  test('a candidate that leaves the area grows it with bboxUnion and refetches cameras before counting', async () => {
    const a = cam('a', LAT0, -84.39);
    // 33.80 is ~5.5 km north of the route, outside the first area (route +/- 2 km).
    const g = cam('g', 33.80, -84.38);
    const farNorth = detourRoute(0.05, 600);
    const south = detourRoute(-0.01, 450);
    const cameraSource = fakeSource([a, g]);
    const router = fakeRouter([straightRoute(), farNorth, south, detourRoute(0.01)]);
    const plan = await planRoutes({ start: START, end: END }, { cameraSource, router });

    assert.ok(cameraSource.calls.length >= 2, 'cameras were not fetched again for the grown area');
    const [first, grown] = cameraSource.calls;
    const eps = 1e-9;
    assert.ok(
      grown.south <= first.south + eps && grown.west <= first.west + eps &&
        grown.north >= first.north - eps && grown.east >= first.east - eps,
      `grown area ${JSON.stringify(grown)} must contain the first area ${JSON.stringify(first)}`,
    );
    const northMargin = distM({ lat: 33.80, lon: -84.38 }, { lat: grown.north, lon: -84.38 });
    assert.ok(
      Math.abs(northMargin - CORRIDOR_MARGIN_M) <= CORRIDOR_MARGIN_M * 0.03,
      `grown area should reach about ${CORRIDOR_MARGIN_M} m past the candidate, got ${northMargin.toFixed(1)} m`,
    );

    // The far-north candidate passes g once g is known, so g is blocked on the next call.
    assert.equal(router.calls.length, 3);
    assert.deepEqual(avoidOf(router.calls[2]), [latLonOf(a), latLonOf(g)]);
    assert.equal(plan.iterations, 2);
    assert.deepEqual(plan.avoiding.route, south);
    assert.deepEqual(sortedIds(plan.cameras), ['a', 'g']);
  });
});
