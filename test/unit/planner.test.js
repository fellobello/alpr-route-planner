// Unit tests for src/planner.js: the builder's own checks, mostly for the points the planRoutes
// JSDoc leaves open (decisions planner.*). No network: sources and routers are in-test fakes.
//
// Geometry: every route starts at START and ends at END in central Atlanta. The fastest route
// runs due east along lat 33.75; a detour goes north or south by an offset, runs east, and comes
// back. Cameras sit on route vertices or hundreds of meters away.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { planRoutes, validatePlanRequest } from '../../src/planner.js';
import {
  DEFAULT_BUFFER_M,
  InputError,
  MAX_AVOID_ITERATIONS,
  NoRouteError,
  TripTooLongError,
  UpstreamError,
} from '../../src/types.js';

const LAT0 = 33.75;
const START = Object.freeze({ lat: LAT0, lon: -84.40 });
const END = Object.freeze({ lat: LAT0, lon: -84.36 });
const LONS = [-84.40, -84.39, -84.38, -84.37, -84.36];

const TOO_MANY = 'Too many cameras to block them all; showing the best route found.';
const NO_OTHER = 'No other route was found.';

function cam(id, lat, lon, extra = {}) {
  return {
    id,
    lat,
    lon,
    isFlock: false,
    manufacturer: null,
    operator: null,
    direction: null,
    source: 'sample',
    ...extra,
  };
}

function straight(durationS = 300) {
  return { points: LONS.map((lon) => [LAT0, lon]), distanceM: 3700, durationS };
}

function detour(offsetDeg, durationS = 400) {
  const lat = LAT0 + offsetDeg;
  return {
    points: [[START.lat, START.lon], ...LONS.map((lon) => [lat, lon]), [END.lat, END.lon]],
    distanceM: 3700 + 2 * Math.abs(offsetDeg) * 111_195,
    durationS,
  };
}

/** Returns the cameras inside the bbox; records each bbox. `script` can override a call's answer. */
function source(cameras, script = []) {
  const calls = [];
  return {
    name: 'fake',
    calls,
    async getCameras(bbox) {
      calls.push({ ...bbox });
      const r = script[calls.length - 1];
      if (r instanceof Error) throw r;
      const list = Array.isArray(r) ? r : cameras;
      return list
        .filter((c) => c.lat >= bbox.south && c.lat <= bbox.north && c.lon >= bbox.west && c.lon <= bbox.east)
        .map((c) => ({ ...c }));
    },
  };
}

/** Call n answers with responses[n] (a Route copy, or an Error thrown). Records request snapshots. */
function router(responses, { maxAvoid = 50 } = {}) {
  const calls = [];
  const raw = [];
  return {
    name: 'fake',
    maxAvoid,
    calls,
    raw,
    async route(req) {
      raw.push(req);
      calls.push(structuredClone(req));
      const r = responses[calls.length - 1];
      if (r === undefined) throw new Error(`unexpected router call #${calls.length}`);
      if (r instanceof Error) throw r;
      return structuredClone(r);
    },
  };
}

const plain = (c) => ({ lat: c.lat, lon: c.lon });

// ---------------------------------------------------------------------------------------------

describe('validatePlanRequest (unit)', () => {
  const ok = { start: { lat: 33.75, lon: -84.4 }, end: { lat: 33.76, lon: -84.38 } };

  test('returns fresh start and end objects with only lat and lon', () => {
    const start = { lat: 33.75, lon: -84.4, name: 'home' };
    const out = validatePlanRequest({ start, end: ok.end });
    assert.notEqual(out.start, start);
    assert.deepEqual(out.start, { lat: 33.75, lon: -84.4 });
    assert.notEqual(out.end, ok.end);
  });

  test('bufferM null, numeric strings and booleans are InputError, not coerced', () => {
    for (const bufferM of [null, '75', true, [75]]) {
      assert.throws(
        () => validatePlanRequest({ ...ok, bufferM }),
        (e) => e instanceof InputError && e.code === 'INPUT' && /bufferM/.test(e.message),
        `bufferM ${JSON.stringify(bufferM)}`,
      );
    }
  });

  test('an explicit undefined bufferM uses the default', () => {
    assert.equal(validatePlanRequest({ ...ok, bufferM: undefined }).bufferM, DEFAULT_BUFFER_M);
  });

  test('numeric-string coordinates are rejected and the message names the field', () => {
    assert.throws(
      () => validatePlanRequest({ start: { lat: '33.75', lon: '-84.4' }, end: ok.end }),
      (e) => e instanceof InputError && /^start /.test(e.message),
    );
    assert.throws(
      () => validatePlanRequest({ start: ok.start, end: { lat: 33.75, lon: 200 } }),
      (e) => e instanceof InputError && /end\.lon/.test(e.message),
    );
  });

  test('TripTooLongError message gives the distance and the limit in km', () => {
    assert.throws(
      () => validatePlanRequest({ start: { lat: 33.5, lon: -84.39 }, end: { lat: 33.96, lon: -84.39 } }),
      (e) => e instanceof TripTooLongError && /51\.\d km/.test(e.message) && /50 km/.test(e.message),
    );
  });

  test('a zero-length trip is fine', () => {
    assert.deepEqual(validatePlanRequest({ start: ok.start, end: ok.start }).end, ok.start);
  });
});

// ---------------------------------------------------------------------------------------------

describe('planRoutes (unit): requests sent to the router', () => {
  test('avoid points are plain {lat, lon} objects, not Camera objects', async () => {
    const r = router([straight(), detour(0.01)]);
    await planRoutes({ start: START, end: END }, { cameraSource: source([cam('a', LAT0, -84.39)]), router: r });
    assert.deepEqual(r.calls[1].avoid, [{ lat: LAT0, lon: -84.39 }]);
  });

  test('a router that mutates its request does not change later requests', async () => {
    const r = router([straight(), detour(0.01), detour(-0.01)]);
    const wrapped = {
      ...r,
      async route(req) {
        const out = await r.route(req);
        req.start.lat = 0;
        req.avoid.push({ lat: 1, lon: 1 });
        return out;
      },
    };
    const a = cam('a', LAT0, -84.39);
    const c = cam('c', LAT0 + 0.01, -84.38);
    await planRoutes({ start: START, end: END }, { cameraSource: source([a, c]), router: wrapped });
    assert.equal(r.calls.length, 3);
    for (const call of r.calls) assert.deepEqual(call.start, plain(START));
    assert.deepEqual(r.calls[2].avoid, [plain(a), plain(c)]);
  });
});

describe('planRoutes (unit): notes wording', () => {
  test('uses the real plural: "1 camera" and "2 cameras"', async () => {
    const nearStart = cam('ns', LAT0, -84.3998);
    const nearEnd = cam('ne', LAT0, -84.3602);
    const plan1 = await planRoutes(
      { start: START, end: END },
      { cameraSource: source([nearStart]), router: router([straight()]) },
    );
    assert.deepEqual(plan1.notes, ["1 camera next to your start or end can't be avoided."]);

    const plan2 = await planRoutes(
      { start: START, end: END },
      { cameraSource: source([nearStart, nearEnd]), router: router([straight()]) },
    );
    assert.deepEqual(plan2.notes, ["2 cameras next to your start or end can't be avoided."]);

    const plan3 = await planRoutes(
      { start: START, end: END },
      {
        cameraSource: source([cam('a', LAT0, -84.39), cam('b', LAT0, -84.37)]),
        router: router([straight(), new NoRouteError('none')]),
      },
    );
    assert.deepEqual(plan3.notes, ['The avoiding route still passes 2 cameras.', NO_OTHER]);
  });

  test('"still passes" counts only avoidable cameras; the two counts never overlap', async () => {
    const nearStart = cam('ns', LAT0, -84.3998);
    const c = cam('c', LAT0 + 0.01, -84.38);
    const r = router([straight(), detour(0.01)], { maxAvoid: 2 });
    // fastest: ns, a, b. blocked [a, b] (cap full). north detour: ns, c; c can't be blocked.
    const plan = await planRoutes(
      { start: START, end: END },
      { cameraSource: source([nearStart, cam('a', LAT0, -84.39), cam('b', LAT0, -84.37), c]), router: r },
    );
    assert.deepEqual(plan.avoiding.cameraIds, ['ns', 'c']);
    assert.deepEqual(plan.notes, [
      "1 camera next to your start or end can't be avoided.",
      'The avoiding route still passes 1 camera.',
      TOO_MANY,
    ]);
  });

  test('the unavoidable note counts cameras on the avoiding route, not every camera near start', async () => {
    // The router snapped the route to a road ~60 m north of START. A camera ~70 m south of START
    // is within bufferM of start but ~130 m from the route, so the route does not pass it.
    const snapped = {
      points: [[LAT0 + 0.00054, -84.40], ...LONS.slice(1).map((lon) => [LAT0 + 0.00054, lon])],
      distanceM: 3700,
      durationS: 300,
    };
    const southOfStart = cam('s', LAT0 - 0.00063, -84.40); // ~70 m from START, ~130 m from the route
    const plan = await planRoutes(
      { start: START, end: END },
      { cameraSource: source([southOfStart]), router: router([snapped]) },
    );
    assert.deepEqual(plan.fastest.cameraIds, []);
    assert.deepEqual(plan.notes, []);
    assert.deepEqual(plan.cameras.map((x) => x.id), ['s']);
  });
});

describe('planRoutes (unit): how the search stops', () => {
  test('a NoRouteError after a first candidate keeps that candidate, counts the failed call, and adds the note', async () => {
    const a = cam('a', LAT0, -84.39);
    const c = cam('c', LAT0 + 0.01, -84.38);
    const b = cam('b', LAT0, -84.37);
    const north = detour(0.01, 400);
    const r = router([straight(), north, new NoRouteError('boxed in')]);
    const plan = await planRoutes({ start: START, end: END }, { cameraSource: source([a, b, c]), router: r });
    assert.equal(r.calls.length, 3);
    assert.equal(plan.iterations, 2);
    assert.deepEqual(plan.avoiding.route, north);
    assert.deepEqual(plan.notes, ['The avoiding route still passes 1 camera.', NO_OTHER]);
  });

  test('other errors from an avoid call propagate unchanged', async () => {
    const boom = new UpstreamError('valhalla', 'HTTP 503');
    const r = router([straight(), boom]);
    await assert.rejects(
      planRoutes({ start: START, end: END }, { cameraSource: source([cam('a', LAT0, -84.39)]), router: r }),
      (e) => e === boom,
    );
  });

  test('the 4-call limit ends the search with the "Too many cameras" note', async () => {
    const cams = [cam('a', LAT0, -84.39), cam('b', LAT0, -84.37)]; // fastest passes 2
    const routes = [straight()];
    for (let k = 1; k <= MAX_AVOID_ITERATIONS + 1; k++) {
      const off = (k % 2 ? 1 : -1) * 0.004 * Math.ceil(k / 2);
      routes.push(detour(off, 400 + k));
      cams.push(cam(`k${k}`, LAT0 + off, -84.38));
    }
    const r = router(routes);
    const plan = await planRoutes({ start: START, end: END }, { cameraSource: source(cams), router: r });
    assert.equal(r.calls.length, 1 + MAX_AVOID_ITERATIONS);
    assert.equal(plan.iterations, MAX_AVOID_ITERATIONS);
    assert.deepEqual(plan.avoiding.cameraIds, ['k1']); // all tie at 1 camera; k1 is fastest
    assert.deepEqual(plan.notes, ['The avoiding route still passes 1 camera.', TOO_MANY]);
  });

  test('a router that ignores the avoid list is not asked again with the same list', async () => {
    const r = router([straight(), straight(320), straight(340)]);
    const plan = await planRoutes(
      { start: START, end: END },
      { cameraSource: source([cam('a', LAT0, -84.39)]), router: r },
    );
    assert.equal(r.calls.length, 2);
    assert.equal(plan.iterations, 1);
    // Same cameras, so the tie goes to the shorter duration: the fastest route.
    assert.deepEqual(plan.avoiding.route, straight(300));
    assert.deepEqual(plan.notes, ['The avoiding route still passes 1 camera.']);
  });

  test('maxAvoid 0 makes no avoid calls and says there are too many cameras', async () => {
    const r = router([straight()], { maxAvoid: 0 });
    const plan = await planRoutes(
      { start: START, end: END },
      { cameraSource: source([cam('a', LAT0, -84.39)]), router: r },
    );
    assert.equal(r.calls.length, 1);
    assert.equal(plan.iterations, 0);
    assert.deepEqual(plan.notes, ['The avoiding route still passes 1 camera.', TOO_MANY]);
  });

  test('a cap that trims blocked still lets a clean reroute end the search with no notes', async () => {
    const r = router([straight(), detour(0.01)], { maxAvoid: 1 });
    const plan = await planRoutes(
      { start: START, end: END },
      { cameraSource: source([cam('a', LAT0, -84.39), cam('b', LAT0, -84.37)]), router: r },
    );
    assert.deepEqual(r.calls[1].avoid, [{ lat: LAT0, lon: -84.39 }]);
    assert.deepEqual(plan.avoiding.cameraIds, []);
    assert.deepEqual(plan.notes, []);
  });

  test('equal camera counts and durations keep the earlier candidate', async () => {
    const a = cam('a', LAT0, -84.39);
    const c = cam('c', LAT0 + 0.01, -84.38);
    const north = detour(0.01, 300);
    const r = router([straight(300), north, new NoRouteError('x')]);
    const plan = await planRoutes({ start: START, end: END }, { cameraSource: source([a, c]), router: r });
    assert.deepEqual(plan.avoiding.route, straight(300));
  });
});

describe('planRoutes (unit): cameras', () => {
  test('duplicate ids from the source are listed once and counted once', async () => {
    const a = cam('a', LAT0, -84.39);
    const plan = await planRoutes(
      { start: START, end: END },
      { cameraSource: source([a, { ...a }]), router: router([straight(), detour(0.01)]) },
    );
    assert.deepEqual(plan.cameras.map((c) => c.id), ['a']);
    assert.deepEqual(plan.fastest.cameraIds, ['a']);
  });

  test('after the area grows, earlier candidates are re-counted with the new cameras', async () => {
    const a = cam('a', LAT0, -84.39);
    // On the fastest route, but the first fetch misses it (as a stale or partly cached source
    // might); the refetch for the grown area returns it.
    const late = cam('late', LAT0, -84.37);
    const farNorth = detour(0.05, 600);
    const src = source([a, late], [[a]]);
    const r = router([straight(), farNorth]);
    const plan = await planRoutes({ start: START, end: END }, { cameraSource: src, router: r });
    assert.equal(src.calls.length, 2);
    assert.deepEqual(plan.fastest.cameraIds, ['a', 'late']);
    assert.deepEqual(plan.cameras.map((c) => c.id).sort(), ['a', 'late']);
  });

  test('an error from the refetch after the area grows propagates unchanged', async () => {
    const boom = new UpstreamError('overpass', 'HTTP 504');
    const src = source([cam('a', LAT0, -84.39)], [undefined, boom]);
    const r = router([straight(), detour(0.05)]);
    await assert.rejects(planRoutes({ start: START, end: END }, { cameraSource: src, router: r }), (e) => e === boom);
  });

  test('a candidate inside the area does not trigger a refetch', async () => {
    const src = source([cam('a', LAT0, -84.39)]);
    await planRoutes({ start: START, end: END }, { cameraSource: src, router: router([straight(), detour(0.01)]) });
    assert.equal(src.calls.length, 1);
  });
});

describe('planRoutes (unit): result shape', () => {
  test('avoiding is its own object even when it is the fastest route', async () => {
    const plan = await planRoutes(
      { start: START, end: END },
      { cameraSource: source([]), router: router([straight()]) },
    );
    assert.notEqual(plan.avoiding, plan.fastest);
    assert.notEqual(plan.avoiding.cameraIds, plan.fastest.cameraIds);
    assert.deepEqual(plan.avoiding, plan.fastest);
  });

  test('the plan survives a JSON round trip unchanged', async () => {
    const plan = await planRoutes(
      { start: START, end: END, bufferM: 100 },
      { cameraSource: source([cam('a', LAT0, -84.39)]), router: router([straight(), detour(0.01)]) },
    );
    assert.deepEqual(JSON.parse(JSON.stringify(plan)), plan);
    assert.deepEqual(Object.keys(plan).sort(), ['avoiding', 'bufferM', 'cameras', 'fastest', 'iterations', 'notes']);
  });
});
