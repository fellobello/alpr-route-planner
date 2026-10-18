import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  EARTH_RADIUS_M,
  haversineM,
  lineLengthM,
  pointToPolylineM,
  positionAlongM,
  camerasNearRoute,
  bboxAround,
  bboxContains,
  bboxUnion,
  circleRing,
  decodePolyline,
  encodePolyline,
} from '../../src/geo.js';
import { InputError } from '../../src/types.js';

const M_PER_DEG = (EARTH_RADIUS_M * Math.PI) / 180; // ~111,195 m
const ATL = { lat: 33.749, lon: -84.388 };

/** Deterministic PRNG so the randomized checks are repeatable. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Assert |actual - expected| <= tol * max(|expected|, floor). */
function near(actual, expected, tol, floor = 1, msg = '') {
  const lim = tol * Math.max(Math.abs(expected), floor);
  assert.ok(
    Math.abs(actual - expected) <= lim,
    `${msg} expected ${expected} +/- ${lim}, got ${actual}`,
  );
}

/** Brute-force reference: densely sample every segment (linear in lat/lon) and take the min haversine. */
function bruteNearest(p, line, steps = 2000) {
  if (line.length === 1) return { dist: haversineM(p, { lat: line[0][0], lon: line[0][1] }), along: 0 };
  let best = Infinity;
  let bestAlong = 0;
  let cum = 0;
  for (let i = 1; i < line.length; i++) {
    const [aLat, aLon] = line[i - 1];
    const [bLat, bLon] = line[i];
    const segLen = haversineM({ lat: aLat, lon: aLon }, { lat: bLat, lon: bLon });
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const q = { lat: aLat + t * (bLat - aLat), lon: aLon + t * (bLon - aLon) };
      const d = haversineM(p, q);
      if (d < best) {
        best = d;
        bestAlong = cum + t * segLen;
      }
    }
    cum += segLen;
  }
  return { dist: best, along: bestAlong };
}

function randomLineNearAtlanta(r, nPoints, spanDeg) {
  const line = [];
  let lat = ATL.lat + (r() - 0.5) * spanDeg;
  let lon = ATL.lon + (r() - 0.5) * spanDeg;
  for (let i = 0; i < nPoints; i++) {
    line.push([lat, lon]);
    lat += (r() - 0.5) * spanDeg * 0.5;
    lon += (r() - 0.5) * spanDeg * 0.5;
  }
  return line;
}

function deepFreeze(o) {
  if (o && typeof o === 'object') {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

function cam(id, lat, lon) {
  return { id, lat, lon, isFlock: false, manufacturer: null, operator: null, direction: null, source: 'sample' };
}

// ---------------------------------------------------------------------------

describe('haversineM', () => {
  test('zero for the same point', () => {
    assert.equal(haversineM(ATL, ATL), 0);
  });

  test('one degree of latitude is R * pi / 180', () => {
    near(haversineM({ lat: 0, lon: 0 }, { lat: 1, lon: 0 }), M_PER_DEG, 1e-9);
    near(haversineM({ lat: 33, lon: -84 }, { lat: 34, lon: -84 }), M_PER_DEG, 1e-9);
  });

  test('one degree of longitude shrinks with cos(latitude)', () => {
    near(haversineM({ lat: 0, lon: 10 }, { lat: 0, lon: 11 }), M_PER_DEG, 1e-9);
    near(haversineM({ lat: 60, lon: 10 }, { lat: 60, lon: 11 }), M_PER_DEG * 0.5, 1e-3);
  });

  test('known city pair: Paris to London is about 343.5 km', () => {
    const paris = { lat: 48.8566, lon: 2.3522 };
    const london = { lat: 51.5074, lon: -0.1278 };
    near(haversineM(paris, london), 343_560, 0.005);
  });

  test('symmetric', () => {
    const a = { lat: 33.7, lon: -84.4 };
    const b = { lat: 33.9, lon: -84.2 };
    assert.equal(haversineM(a, b), haversineM(b, a));
  });

  test('takes the short way across the antimeridian', () => {
    near(haversineM({ lat: 0, lon: 179.9 }, { lat: 0, lon: -179.9 }), M_PER_DEG * 0.2, 1e-6);
  });

  test('antipodes are half the circumference', () => {
    near(haversineM({ lat: 0, lon: 0 }, { lat: 0, lon: 180 }), Math.PI * EARTH_RADIUS_M, 1e-9);
  });
});

describe('lineLengthM', () => {
  test('0 for fewer than 2 points', () => {
    assert.equal(lineLengthM([]), 0);
    assert.equal(lineLengthM([[33.7, -84.4]]), 0);
  });

  test('sum of haversine segments', () => {
    const line = [
      [33.7, -84.4],
      [33.71, -84.4],
      [33.71, -84.39],
    ];
    const expected =
      haversineM({ lat: 33.7, lon: -84.4 }, { lat: 33.71, lon: -84.4 }) +
      haversineM({ lat: 33.71, lon: -84.4 }, { lat: 33.71, lon: -84.39 });
    near(lineLengthM(line), expected, 1e-12);
  });

  test('a repeated point adds nothing', () => {
    assert.equal(lineLengthM([[1, 1], [1, 1]]), 0);
  });

  test('throws InputError for a non-array or a bad pair', () => {
    assert.throws(() => lineLengthM(/** @type {any} */ (null)), InputError);
    assert.throws(() => lineLengthM(/** @type {any} */ ([[1, 1], [1, 'x']])), InputError);
    assert.throws(() => lineLengthM(/** @type {any} */ ([[1, 1], null])), InputError);
  });
});

describe('pointToPolylineM', () => {
  const line = [
    [33.75, -84.4],
    [33.75, -84.38],
  ]; // ~1.85 km east-west segment

  test('0 for a point on a vertex', () => {
    assert.equal(pointToPolylineM({ lat: 33.75, lon: -84.4 }, line), 0);
  });

  test('~0 for a point in the middle of a segment', () => {
    assert.ok(pointToPolylineM({ lat: 33.75, lon: -84.39 }, line) < 0.05);
  });

  test('perpendicular distance to the middle of a segment, not the vertices', () => {
    const p = { lat: 33.75 + 100 / M_PER_DEG, lon: -84.39 };
    near(pointToPolylineM(p, line), 100, 0.01);
    // Both vertices are ~930 m away, so this really measures to the segment.
    assert.ok(haversineM(p, { lat: 33.75, lon: -84.4 }) > 900);
  });

  test('beyond the end it is the distance to the end vertex', () => {
    const p = { lat: 33.75, lon: -84.37 };
    near(pointToPolylineM(p, line), haversineM(p, { lat: 33.75, lon: -84.38 }), 1e-9);
  });

  test('a 1-point line is that point', () => {
    const p = { lat: 33.76, lon: -84.39 };
    assert.equal(pointToPolylineM(p, [[33.75, -84.4]]), haversineM(p, { lat: 33.75, lon: -84.4 }));
  });

  test('minimum over all segments', () => {
    const zigzag = [
      [33.7, -84.5],
      [33.8, -84.5],
      [33.8, -84.4],
    ];
    const p = { lat: 33.75, lon: -84.4 + 0.001 }; // far from first leg, near neither end of second
    const d = pointToPolylineM(p, zigzag);
    near(d, bruteNearest(p, zigzag).dist, 0.01, 1);
  });

  test('within 1% of a dense brute-force reference on random lines under 100 km', () => {
    const r = rng(42);
    for (let k = 0; k < 60; k++) {
      const line = randomLineNearAtlanta(r, 2 + Math.floor(r() * 6), 0.4);
      const p = { lat: ATL.lat + (r() - 0.5) * 0.6, lon: ATL.lon + (r() - 0.5) * 0.6 };
      const got = pointToPolylineM(p, line);
      const ref = bruteNearest(p, line).dist;
      // floor of 10 m: brute-force sampling resolution is a few meters on long segments
      near(got, ref, 0.01, 10, `case ${k}`);
      assert.ok(got >= ref - 10, `case ${k}: result ${got} is well below reference ${ref}`);
    }
  });

  test('works across the antimeridian', () => {
    const wrapLine = [
      [10, 179.95],
      [10, -179.95],
    ];
    const p = { lat: 10 + 50 / M_PER_DEG, lon: 180 };
    near(pointToPolylineM(p, wrapLine), 50, 0.01);
  });

  test('throws InputError for an empty line or bad input', () => {
    assert.throws(() => pointToPolylineM(ATL, []), InputError);
    assert.throws(() => pointToPolylineM(/** @type {any} */ ({ lat: NaN, lon: 0 }), line), InputError);
    assert.throws(() => pointToPolylineM(ATL, /** @type {any} */ ([[1, 'x']])), InputError);
  });
});

describe('positionAlongM', () => {
  const line = [
    [33.75, -84.4],
    [33.75, -84.39],
    [33.76, -84.39],
  ];
  const total = lineLengthM(line);
  const first = haversineM({ lat: 33.75, lon: -84.4 }, { lat: 33.75, lon: -84.39 });

  test('0 at the start and the total at the end', () => {
    assert.equal(positionAlongM({ lat: 33.75, lon: -84.4 }, line), 0);
    near(positionAlongM({ lat: 33.76, lon: -84.39 }, line), total, 1e-12);
  });

  test('half way along the first segment', () => {
    near(positionAlongM({ lat: 33.7501, lon: -84.395 }, line), first / 2, 0.01);
  });

  test('on the second segment adds the first segment length', () => {
    const second = haversineM({ lat: 33.75, lon: -84.39 }, { lat: 33.76, lon: -84.39 });
    near(positionAlongM({ lat: 33.755, lon: -84.3899 }, line), first + second / 2, 0.01);
  });

  test('clamped to [0, length] for points beyond the ends', () => {
    assert.equal(positionAlongM({ lat: 33.75, lon: -84.5 }, line), 0);
    assert.equal(positionAlongM({ lat: 33.9, lon: -84.39 }, line), total);
  });

  test('a 1-point line gives 0', () => {
    assert.equal(positionAlongM(ATL, [[33.75, -84.4]]), 0);
  });

  test('always within [0, lineLengthM] and close to the brute-force reference', () => {
    const r = rng(7);
    for (let k = 0; k < 40; k++) {
      const l = randomLineNearAtlanta(r, 2 + Math.floor(r() * 5), 0.2);
      const len = lineLengthM(l);
      // a point near the line so the nearest segment is unambiguous
      const i = Math.floor(r() * (l.length - 1));
      const t = r();
      const p = {
        lat: l[i][0] + t * (l[i + 1][0] - l[i][0]) + (r() - 0.5) * 1e-4,
        lon: l[i][1] + t * (l[i + 1][1] - l[i][1]) + (r() - 0.5) * 1e-4,
      };
      const got = positionAlongM(p, l);
      assert.ok(got >= 0 && got <= len, `case ${k}: ${got} not in [0, ${len}]`);
      const ref = bruteNearest(p, l);
      // only compare when the reference agrees the point is close (avoids self-crossing ambiguity)
      if (ref.dist < 20) near(got, ref.along, 0.01, 50, `case ${k}`);
    }
  });

  test('throws InputError for an empty line', () => {
    assert.throws(() => positionAlongM(ATL, []), InputError);
  });
});

describe('camerasNearRoute', () => {
  // A 2 km route heading east from ATL.
  const route = [
    [ATL.lat, ATL.lon],
    [ATL.lat, ATL.lon + 2000 / (M_PER_DEG * Math.cos((ATL.lat * Math.PI) / 180))],
  ];
  const dLat = (m) => m / M_PER_DEG;
  const dLon = (m) => m / (M_PER_DEG * Math.cos((ATL.lat * Math.PI) / 180));

  const cams = [
    cam('c-late', ATL.lat + dLat(30), ATL.lon + dLon(1500)), // 30 m off, 1.5 km along
    cam('c-far', ATL.lat + dLat(200), ATL.lon + dLon(500)), // 200 m off: out at 75 m
    cam('c-early', ATL.lat - dLat(50), ATL.lon + dLon(200)), // 50 m off, 0.2 km along
    cam('c-mid-b', ATL.lat + dLat(10), ATL.lon + dLon(1000)), // tie on position with c-mid-a
    cam('c-mid-a', ATL.lat - dLat(10), ATL.lon + dLon(1000)),
    cam('c-past-end', ATL.lat, ATL.lon + dLon(2060)), // 60 m past the end vertex
    cam('c-way-off', ATL.lat + 1, ATL.lon), // ~111 km away
  ];

  test('keeps cameras within the buffer, ordered along the route, ties by id', () => {
    const got = camerasNearRoute(cams, route, 75).map((c) => c.id);
    assert.deepEqual(got, ['c-early', 'c-mid-a', 'c-mid-b', 'c-late', 'c-past-end']);
  });

  test('a bigger buffer picks up more', () => {
    const got = camerasNearRoute(cams, route, 250).map((c) => c.id);
    assert.deepEqual(got, ['c-early', 'c-far', 'c-mid-a', 'c-mid-b', 'c-late', 'c-past-end']);
  });

  test('a smaller buffer picks up fewer', () => {
    const got = camerasNearRoute(cams, route, 15).map((c) => c.id);
    assert.deepEqual(got, ['c-mid-a', 'c-mid-b']);
  });

  test('the buffer is inclusive', () => {
    const c = cams[2];
    const d = pointToPolylineM(c, route);
    assert.deepEqual(camerasNearRoute([c], route, d), [c]);
    assert.deepEqual(camerasNearRoute([c], route, d - 0.01), []);
  });

  test('ties on position are broken by id in code-unit order', () => {
    const a = cam('sample:2', ATL.lat, ATL.lon + dLon(500));
    const b = cam('sample:10', ATL.lat, ATL.lon + dLon(500));
    assert.deepEqual(
      camerasNearRoute([a, b], route, 75).map((c) => c.id),
      ['sample:10', 'sample:2'],
    );
  });

  test('does not mutate the input and returns the same camera objects', () => {
    const frozen = deepFreeze(structuredClone(cams));
    const frozenRoute = deepFreeze(structuredClone(route));
    const got = camerasNearRoute(frozen, frozenRoute, 75);
    assert.notEqual(got, frozen);
    assert.ok(got.every((c) => frozen.includes(c)));
    assert.deepEqual(frozen, cams);
  });

  test('agrees with pointToPolylineM and positionAlongM on random data', () => {
    const r = rng(99);
    const line = randomLineNearAtlanta(r, 30, 0.02);
    const many = [];
    for (let i = 0; i < 300; i++) {
      many.push(cam(`r${i}`, ATL.lat + (r() - 0.5) * 0.1, ATL.lon + (r() - 0.5) * 0.1));
    }
    const buffer = 120;
    const got = camerasNearRoute(many, line, buffer);
    const expected = many
      .filter((c) => pointToPolylineM(c, line) <= buffer)
      .map((c) => ({ c, along: positionAlongM(c, line) }))
      .sort((x, y) => x.along - y.along || (x.c.id < y.c.id ? -1 : x.c.id > y.c.id ? 1 : 0))
      .map((x) => x.c);
    assert.ok(expected.length > 0, 'test data should produce hits');
    assert.deepEqual(got, expected);
  });

  test('empty camera list gives an empty result', () => {
    assert.deepEqual(camerasNearRoute([], route, 75), []);
  });

  test('works with a 1-point line', () => {
    const c = cam('x', ATL.lat + dLat(20), ATL.lon);
    assert.deepEqual(camerasNearRoute([c], [[ATL.lat, ATL.lon]], 75), [c]);
  });

  test('skips cameras without usable coordinates', () => {
    const bad = /** @type {any} */ ({ id: 'bad', lat: NaN, lon: ATL.lon });
    assert.deepEqual(camerasNearRoute([bad, cams[0]], route, 75), [cams[0]]);
  });

  test('throws InputError for an empty line', () => {
    assert.throws(() => camerasNearRoute(cams, [], 75), InputError);
  });

  test('throws InputError for a bad pair or bad buffer', () => {
    assert.throws(() => camerasNearRoute(cams, /** @type {any} */ ([[1, 1], null]), 75), InputError);
    assert.throws(() => camerasNearRoute(cams, /** @type {any} */ ([[1, 1], [1, 'x']]), 75), InputError);
    assert.throws(() => camerasNearRoute(cams, route, NaN), InputError);
    assert.throws(() => camerasNearRoute(/** @type {any} */ (null), route, 75), InputError);
  });

  test('a negative buffer matches nothing', () => {
    assert.deepEqual(camerasNearRoute(cams, route, -1), []);
  });

  test('an infinite buffer keeps every positioned camera, still ordered', () => {
    const got = camerasNearRoute(cams, route, Infinity).map((c) => c.id);
    assert.equal(got.length, cams.length);
    assert.equal(got[got.length - 1], 'c-past-end');
  });

  test('finds cameras on a line that crosses the antimeridian', () => {
    const wrapLine = [
      [10, 179.95],
      [10, -179.95],
    ];
    const onIt = cam('wrap-on', 10, 179.99);
    const offIt = cam('wrap-off', 10.01, 179.99); // ~1.1 km north
    assert.deepEqual(camerasNearRoute([offIt, onIt], wrapLine, 75), [onIt]);
  });
});

describe('bboxAround', () => {
  test('margin 0 gives the exact extent; accepts mixed objects and pairs', () => {
    const b = bboxAround([{ lat: 33.7, lon: -84.4 }, [33.8, -84.3], { lat: 33.75, lon: -84.5 }], 0);
    assert.deepEqual(b, { south: 33.7, west: -84.5, north: 33.8, east: -84.3 });
  });

  test('a single point with no margin is a degenerate box', () => {
    assert.deepEqual(bboxAround([ATL], 0), { south: ATL.lat, west: ATL.lon, north: ATL.lat, east: ATL.lon });
  });

  test('grows by marginM on every side (within 1%)', () => {
    const margin = 2000;
    const b = bboxAround([ATL, [33.8, -84.3]], margin);
    near(haversineM({ lat: b.south, lon: ATL.lon }, { lat: ATL.lat, lon: ATL.lon }), margin, 0.01);
    near(haversineM({ lat: b.north, lon: -84.3 }, { lat: 33.8, lon: -84.3 }), margin, 0.01);
    near(haversineM({ lat: ATL.lat, lon: b.west }, ATL), margin, 0.01);
    near(haversineM({ lat: 33.8, lon: b.east }, { lat: 33.8, lon: -84.3 }), margin, 0.01);
  });

  test('contains every point within marginM of the input points', () => {
    const r = rng(5);
    const pts = [ATL, [33.9, -84.2]];
    const margin = 1500;
    const b = bboxAround(pts, margin);
    for (let i = 0; i < 500; i++) {
      const base = i % 2 ? { lat: 33.9, lon: -84.2 } : ATL;
      const ring = circleRing(base, margin * r(), 16);
      for (const [lon, lat] of ring) assert.ok(bboxContains(b, { lat, lon }), `(${lat}, ${lon}) outside`);
    }
  });

  test('clamped to the world', () => {
    const b = bboxAround([[89.99, 179.99], [-89.99, -179.99]], 10_000);
    assert.deepEqual(b, { south: -90, west: -180, north: 90, east: 180 });
  });

  test('does not mutate the input', () => {
    const pts = deepFreeze([ATL, [33.8, -84.3]]);
    bboxAround(pts, 100);
  });

  test('throws InputError for no points or bad input', () => {
    assert.throws(() => bboxAround([], 100), InputError);
    assert.throws(() => bboxAround(/** @type {any} */ (null), 100), InputError);
    assert.throws(() => bboxAround([ATL], -1), InputError);
    assert.throws(() => bboxAround([ATL], NaN), InputError);
    assert.throws(() => bboxAround(/** @type {any} */ ([{ lat: 'x', lon: 1 }]), 0), InputError);
  });
});

describe('bboxContains', () => {
  const b = { south: 33.7, west: -84.5, north: 33.8, east: -84.3 };

  test('inside and outside', () => {
    assert.equal(bboxContains(b, ATL), true);
    assert.equal(bboxContains(b, { lat: 33.9, lon: -84.4 }), false);
    assert.equal(bboxContains(b, { lat: 33.75, lon: -84.2 }), false);
    assert.equal(bboxContains(b, { lat: 33.6, lon: -84.4 }), false);
    assert.equal(bboxContains(b, { lat: 33.75, lon: -84.6 }), false);
  });

  test('edges and corners are inclusive', () => {
    assert.equal(bboxContains(b, { lat: 33.7, lon: -84.4 }), true);
    assert.equal(bboxContains(b, { lat: 33.8, lon: -84.4 }), true);
    assert.equal(bboxContains(b, { lat: 33.75, lon: -84.5 }), true);
    assert.equal(bboxContains(b, { lat: 33.75, lon: -84.3 }), true);
    assert.equal(bboxContains(b, { lat: 33.7, lon: -84.5 }), true);
    assert.equal(bboxContains(b, { lat: 33.8, lon: -84.3 }), true);
  });
});

describe('bboxUnion', () => {
  test('smallest box containing both', () => {
    const a = { south: 33.7, west: -84.5, north: 33.8, east: -84.3 };
    const b = { south: 33.75, west: -84.6, north: 33.9, east: -84.4 };
    assert.deepEqual(bboxUnion(a, b), { south: 33.7, west: -84.6, north: 33.9, east: -84.3 });
  });

  test('union with a contained box is the outer box, and it is symmetric', () => {
    const outer = { south: 0, west: 0, north: 10, east: 10 };
    const inner = { south: 2, west: 2, north: 3, east: 3 };
    assert.deepEqual(bboxUnion(outer, inner), outer);
    assert.deepEqual(bboxUnion(inner, outer), outer);
  });

  test('does not mutate the inputs', () => {
    const a = Object.freeze({ south: 0, west: 0, north: 1, east: 1 });
    const b = Object.freeze({ south: 1, west: 1, north: 2, east: 2 });
    const u = bboxUnion(a, b);
    assert.notEqual(u, a);
    assert.notEqual(u, b);
  });
});

describe('circleRing', () => {
  test('default 12 sides: 13 positions, closed', () => {
    const ring = circleRing(ATL, 75);
    assert.equal(ring.length, 13);
    assert.deepEqual(ring[12], ring[0]);
  });

  test('sides + 1 positions for a custom count', () => {
    const ring = circleRing(ATL, 75, 8);
    assert.equal(ring.length, 9);
    assert.deepEqual(ring[8], ring[0]);
  });

  test('positions are [lon, lat] and start due north', () => {
    const ring = circleRing(ATL, 100, 4);
    const [lon0, lat0] = ring[0];
    near(lon0, ATL.lon, 1e-12);
    assert.ok(lat0 > ATL.lat);
    near((lat0 - ATL.lat) * M_PER_DEG, 100, 1e-6);
    // second vertex is due west (counterclockwise)
    const [lon1, lat1] = ring[1];
    assert.ok(lon1 < ATL.lon);
    near(lat1, ATL.lat, 1e-6);
  });

  test('every vertex is radiusM from the center', () => {
    for (const r of [15, 75, 300, 5000]) {
      for (const [lon, lat] of circleRing(ATL, r, 24).slice(0, -1)) {
        near(haversineM(ATL, { lat, lon }), r, 1e-6, 1, `radius ${r}`);
      }
    }
  });

  test('ring is counterclockwise (positive signed area in lon/lat)', () => {
    const ring = circleRing(ATL, 500, 12);
    let area2 = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      area2 += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    }
    assert.ok(area2 > 0);
  });

  test('longitudes stay inside [-180, 180] near the antimeridian', () => {
    for (const [lon] of circleRing({ lat: 0, lon: 179.9999 }, 1000, 12)) {
      assert.ok(lon >= -180 && lon <= 180, `lon ${lon}`);
    }
  });

  test('throws InputError for bad input', () => {
    assert.throws(() => circleRing(ATL, 75, 2), InputError);
    assert.throws(() => circleRing(ATL, 75, 3.5), InputError);
    assert.throws(() => circleRing(ATL, -1), InputError);
    assert.throws(() => circleRing(/** @type {any} */ ({ lat: null, lon: 0 }), 75), InputError);
  });
});

describe('polyline encode/decode', () => {
  // Google's documented example (precision 5).
  const GOOGLE = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';
  const GOOGLE_POINTS = [
    [38.5, -120.2],
    [40.7, -120.95],
    [43.252, -126.453],
  ];

  test("decodes Google's example at precision 5", () => {
    assert.deepEqual(decodePolyline(GOOGLE, 5), GOOGLE_POINTS);
  });

  test("encodes Google's example at precision 5", () => {
    assert.equal(encodePolyline(GOOGLE_POINTS, 5), GOOGLE);
  });

  test('precision 6 is the default', () => {
    const enc = encodePolyline(GOOGLE_POINTS);
    assert.equal(enc, encodePolyline(GOOGLE_POINTS, 6));
    assert.notEqual(enc, GOOGLE);
    assert.deepEqual(decodePolyline(enc), GOOGLE_POINTS);
  });

  test('known precision-6 value', () => {
    // One point at (1, 1), checked against the reference (bitwise) algorithm:
    // precision 6 -> 1e6 -> '_c`|@'; precision 5 -> 1e5 -> '_ibE'.
    assert.equal(encodePolyline([[1, 1]]), '_c`|@_c`|@');
    assert.deepEqual(decodePolyline('_c`|@_c`|@'), [[1, 1]]);
    assert.equal(encodePolyline([[1, 1]], 5), '_ibE_ibE');
    assert.deepEqual(decodePolyline('_ibE_ibE', 5), [[1, 1]]);
  });

  test('empty in, empty out', () => {
    assert.equal(encodePolyline([]), '');
    assert.deepEqual(decodePolyline(''), []);
  });

  test('round trip equals the input rounded to p decimals', () => {
    const r = rng(1234);
    for (const p of [5, 6, 7]) {
      const f = 10 ** p;
      const pts = [];
      for (let i = 0; i < 200; i++) pts.push([(r() - 0.5) * 180, (r() - 0.5) * 360]);
      const back = decodePolyline(encodePolyline(pts, p), p);
      assert.deepEqual(
        back,
        pts.map(([a, b]) => [Math.round(a * f) / f, Math.round(b * f) / f]),
        `precision ${p}`,
      );
    }
  });

  test('round trip of extreme coordinates', () => {
    const pts = [
      [90, 180],
      [-90, -180],
      [0, 0],
      [-90, 180],
    ];
    assert.deepEqual(decodePolyline(encodePolyline(pts)), pts);
    assert.deepEqual(decodePolyline(encodePolyline(pts, 10), 10), pts);
  });

  test('a route-sized polyline survives a round trip', () => {
    const r = rng(3);
    const line = randomLineNearAtlanta(r, 2000, 0.001).map(([a, b]) => [
      Math.round(a * 1e6) / 1e6,
      Math.round(b * 1e6) / 1e6,
    ]);
    assert.deepEqual(decodePolyline(encodePolyline(line)), line);
  });

  test('throws InputError for malformed input', () => {
    assert.throws(() => decodePolyline('_c`|@'), InputError); // latitude without longitude
    assert.throws(() => decodePolyline('_'), InputError); // truncated value
    assert.throws(() => decodePolyline('_c`|@ c`|@'), InputError); // space is below "?"
    assert.throws(() => decodePolyline(/** @type {any} */ (42)), InputError);
    assert.throws(() => decodePolyline('', 1.5), InputError);
    assert.throws(() => encodePolyline([[1, 1]], -1), InputError);
    assert.throws(() => encodePolyline(/** @type {any} */ ([[1, NaN]])), InputError);
  });
});
