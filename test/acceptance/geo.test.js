// Acceptance tests for src/geo.js, written only from .hub/spec.md and the JSDoc in
// src/geo.js / src/types.js. They check documented behavior, not implementation details.
//
// Tolerances: the spec promises distances "accurate to 1% under 100 km", so every
// distance-valued result is checked to within 1%. Results the docs state exactly
// (bbox edges with no margin, clamps, ring closure, polyline strings) are checked exactly
// or to floating-point noise (1e-9 degrees).

import { describe, test } from 'node:test';
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

// ---- helpers (independent of the module under test) ----

const M_PER_DEG = (6_371_008.8 * Math.PI) / 180; // meters per degree of latitude
const ATL = Object.freeze({ lat: 33.749, lon: -84.388 });

/** Point moved northM meters north and eastM meters east of p (small offsets only). */
function offset(p, northM, eastM = 0) {
  return {
    lat: p.lat + northM / M_PER_DEG,
    lon: p.lon + eastM / (M_PER_DEG * Math.cos((p.lat * Math.PI) / 180)),
  };
}

/** [lat, lon] pair for a {lat, lon} point. */
const pair = (p) => [p.lat, p.lon];

function assertWithinPct(actual, expected, pct, label) {
  assert.equal(typeof actual, 'number', `${label}: expected a number, got ${typeof actual}`);
  assert.ok(Number.isFinite(actual), `${label}: expected a finite number, got ${actual}`);
  const tol = Math.abs(expected) * (pct / 100);
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${label}: expected ${expected} (within ${pct}%), got ${actual}`,
  );
}

function assertClose(actual, expected, tol, label) {
  assert.equal(typeof actual, 'number', `${label}: expected a number, got ${typeof actual}`);
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${label}: expected ${expected} (within ${tol}), got ${actual}`,
  );
}

function assertPairsClose(actual, expected, tol, label) {
  assert.ok(Array.isArray(actual), `${label}: expected an array, got ${typeof actual}`);
  assert.equal(actual.length, expected.length, `${label}: wrong number of points`);
  expected.forEach(([lat, lon], i) => {
    assert.ok(Array.isArray(actual[i]) && actual[i].length === 2, `${label}: point ${i} is not a [lat, lon] pair`);
    assertClose(actual[i][0], lat, tol, `${label}: point ${i} lat`);
    assertClose(actual[i][1], lon, tol, `${label}: point ${i} lon`);
  });
}

function assertBBoxClose(actual, expected, tol, label) {
  for (const key of ['south', 'west', 'north', 'east']) {
    assertClose(actual[key], expected[key], tol, `${label}: ${key}`);
  }
}

function assertInputError(fn, label) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof InputError, `${label}: expected InputError, got ${err && err.name}: ${err && err.message}`);
    assert.equal(err.code, 'INPUT', `${label}: expected code INPUT`);
    return true;
  });
}

/** A full Camera record at point p. */
function cam(id, p, extra = {}) {
  return {
    id,
    lat: p.lat,
    lon: p.lon,
    isFlock: false,
    manufacturer: null,
    operator: null,
    direction: null,
    source: 'sample',
    ...extra,
  };
}

// An L-shaped route used by several tests: A, then 2000 m north to B, then 3000 m east to C.
const A = ATL;
const B = offset(A, 2000);
const C = offset(B, 0, 3000);
const L_LINE = [pair(A), pair(B), pair(C)];

// A straight 2000 m route due north from A.
const N_LINE = [pair(A), pair(B)];

// ---- EARTH_RADIUS_M ----

describe('geo: EARTH_RADIUS_M', () => {
  test('EARTH_RADIUS_M is the mean Earth radius, 6,371,008.8 m', () => {
    assert.equal(EARTH_RADIUS_M, 6_371_008.8);
  });
});

// ---- haversineM ----

describe('geo: haversineM', () => {
  test('haversineM returns 0 for the same point', () => {
    assert.equal(haversineM(ATL, { ...ATL }), 0);
  });

  test('haversineM: 0.1 degree of latitude is about 11,119.5 m (within 1%)', () => {
    const d = haversineM({ lat: 33.7, lon: -84.4 }, { lat: 33.8, lon: -84.4 });
    assertWithinPct(d, M_PER_DEG * 0.1, 1, 'haversineM(0.1 deg lat)');
  });

  test('haversineM is great-circle distance, not a flat projection: (0,0) to (45,90) is a quarter of the globe', () => {
    // On a sphere these points are exactly 90 degrees apart; a flat lat/lon projection is ~5% off.
    const d = haversineM({ lat: 0, lon: 0 }, { lat: 45, lon: 90 });
    assertWithinPct(d, (EARTH_RADIUS_M * Math.PI) / 2, 1, 'haversineM(quarter globe)');
  });
});

// ---- lineLengthM ----

describe('geo: lineLengthM', () => {
  test('lineLengthM is the sum of haversine segment lengths', () => {
    const expected =
      haversineM({ lat: L_LINE[0][0], lon: L_LINE[0][1] }, { lat: L_LINE[1][0], lon: L_LINE[1][1] }) +
      haversineM({ lat: L_LINE[1][0], lon: L_LINE[1][1] }, { lat: L_LINE[2][0], lon: L_LINE[2][1] });
    assertWithinPct(lineLengthM(L_LINE), expected, 1e-6, 'lineLengthM(L line)');
    assertWithinPct(lineLengthM(L_LINE), 5000, 1, 'lineLengthM(2000 m + 3000 m)');
  });

  test('lineLengthM is 0 for fewer than 2 points (empty and 1-point lines)', () => {
    assert.equal(lineLengthM([]), 0, 'empty line');
    assert.equal(lineLengthM([pair(ATL)]), 0, '1-point line');
  });
});

// ---- pointToPolylineM ----

describe('geo: pointToPolylineM', () => {
  test('pointToPolylineM measures to the middle of a segment, not just its vertices', () => {
    // 500 m east of the midpoint of a 2000 m north-south segment; the vertices are ~1118 m away.
    const p = offset(A, 1000, 500);
    assertWithinPct(pointToPolylineM(p, N_LINE), 500, 1, 'distance to segment middle');
  });

  test('pointToPolylineM measures to the end point when the point is past the end of the line', () => {
    // 1000 m north of the north end, in line with the segment: 1000 m, not 0.
    const p = offset(B, 1000);
    assertWithinPct(pointToPolylineM(p, N_LINE), 1000, 1, 'distance past the end');
  });

  test('pointToPolylineM uses the nearest of several segments', () => {
    // 200 m south of the middle of B->C (the second segment); A->B is ~1500 m away.
    const p = offset(offset(B, 0, 1500), -200);
    assertWithinPct(pointToPolylineM(p, L_LINE), 200, 1, 'distance to second segment');
  });

  test('pointToPolylineM treats a 1-point line as that point', () => {
    const p = offset(A, 300, 400); // 500 m from A
    assertWithinPct(pointToPolylineM(p, [pair(A)]), 500, 1, 'distance to 1-point line');
  });

  test('pointToPolylineM throws InputError (code INPUT) for an empty line', () => {
    assertInputError(() => pointToPolylineM(ATL, []), 'pointToPolylineM(p, [])');
  });
});

// ---- positionAlongM ----

describe('geo: positionAlongM', () => {
  test('positionAlongM is the distance from the first point to the nearest point on the line', () => {
    // 300 m west of the first segment, 800 m along it.
    assertWithinPct(positionAlongM(offset(A, 800, -300), L_LINE), 800, 1, 'point beside segment 1');
    // 200 m south of the middle of the second segment: 2000 m + 1500 m along.
    assertWithinPct(positionAlongM(offset(offset(B, 0, 1500), -200), L_LINE), 3500, 1, 'point beside segment 2');
  });

  test('positionAlongM is 0 (never negative) for a point before the start of the line', () => {
    // 500 m south of the first point, in line with the first segment.
    const v = positionAlongM(offset(A, -500), L_LINE);
    assert.ok(v >= 0, `expected >= 0, got ${v}`);
    assertClose(v, 0, 1, 'position before the start');
  });

  test('positionAlongM is lineLengthM(line) for a point past the end (not extrapolated beyond it)', () => {
    // 500 m east of the last point, in line with the last segment. Extrapolating would give
    // lineLengthM + 500 (10% over); the 1% tolerance only allows for approximation.
    const len = lineLengthM(L_LINE);
    const v = positionAlongM(offset(C, 0, 500), L_LINE);
    assertWithinPct(v, len, 1, 'position past the end');
  });
});

// ---- camerasNearRoute ----

describe('geo: camerasNearRoute', () => {
  test('camerasNearRoute keeps cameras within bufferM of the line and drops the rest', () => {
    const cameras = [
      cam('sample:1', offset(A, 500, 40)), // 40 m from the line: in
      cam('sample:2', offset(A, 1500, -90)), // 90 m: in
      cam('sample:3', offset(A, 1000, 150)), // 150 m: out
      cam('sample:4', offset(A, 1000, -1000)), // 1000 m: out
      cam('sample:5', offset(B, 60)), // 60 m past the north end: in
      cam('sample:6', offset(B, 120)), // 120 m past the north end (in line with it): out
    ];
    const ids = camerasNearRoute(cameras, N_LINE, 100).map((c) => c.id).sort();
    assert.deepEqual(ids, ['sample:1', 'sample:2', 'sample:5']);
  });

  test('camerasNearRoute treats the buffer as inclusive (distance <= bufferM): a camera on the line is kept with bufferM 0', () => {
    const onLine = cam('sample:1', { lat: N_LINE[0][0], lon: N_LINE[0][1] });
    const off = cam('sample:2', offset(A, 1000, 20));
    assert.deepEqual(camerasNearRoute([onLine, off], N_LINE, 0).map((c) => c.id), ['sample:1']);
  });

  test('camerasNearRoute orders cameras by position along the route (not input order or id) and returns full Camera records', () => {
    const c1 = cam('sample:1', offset(offset(B, 0, 2000), -30), { isFlock: true, manufacturer: 'Flock Safety' }); // 4000 m along
    const c2 = cam('sample:2', offset(A, 300, 30), { operator: 'City of Atlanta', direction: 90 }); // 300 m along
    const c3 = cam('sample:3', offset(offset(B, 0, 500), 30)); // 2500 m along
    const result = camerasNearRoute([c1, c2, c3], L_LINE, 75);
    assert.deepEqual(result.map((c) => c.id), ['sample:2', 'sample:3', 'sample:1']);
    assert.deepEqual(result, [c2, c3, c1]);
  });

  test('camerasNearRoute breaks ties in position along the route by id', () => {
    const p = offset(A, 1000, 20);
    const cameras = [
      cam('osm:node/200', p),
      cam('osm:node/300', offset(A, 500, 20)), // earlier along the route, so first despite the larger id
      cam('osm:node/100', { ...p }), // same spot as osm:node/200
    ];
    const ids = camerasNearRoute(cameras, N_LINE, 75).map((c) => c.id);
    assert.deepEqual(ids, ['osm:node/300', 'osm:node/100', 'osm:node/200']);
  });

  test('camerasNearRoute does not mutate its inputs', () => {
    // Given in reverse route order, so sorting the input in place would show up.
    const cameras = [
      cam('sample:1', offset(A, 1500, 10)),
      cam('sample:2', offset(A, 900, 10)),
      cam('sample:3', offset(A, 200, 10)),
      cam('sample:4', offset(A, 1000, 900)), // filtered out
    ];
    const line = N_LINE.map((pt) => [...pt]);
    const camerasBefore = structuredClone(cameras);
    const lineBefore = structuredClone(line);
    camerasNearRoute(cameras, line, 75);
    assert.deepEqual(cameras, camerasBefore, 'cameras array or its objects changed');
    assert.deepEqual(line, lineBefore, 'line changed');
  });
});

// ---- bboxAround ----

describe('geo: bboxAround', () => {
  const POINTS = [
    { lat: 33.75, lon: -84.39 },
    [33.76, -84.4],
    { lat: 33.74, lon: -84.38 },
    [33.755, -84.385],
  ];

  test('bboxAround with marginM 0 is the smallest bbox containing every point ({lat, lon} and [lat, lon] mixed)', () => {
    assertBBoxClose(
      bboxAround(POINTS, 0),
      { south: 33.74, west: -84.4, north: 33.76, east: -84.38 },
      1e-9,
      'bboxAround(points, 0)',
    );
  });

  test('bboxAround grows the bbox by marginM on all four sides', () => {
    const b = bboxAround(POINTS, 2000);
    const mPerDegLon = M_PER_DEG * Math.cos((33.75 * Math.PI) / 180);
    assertWithinPct((b.north - 33.76) * M_PER_DEG, 2000, 1, 'north margin (m)');
    assertWithinPct((33.74 - b.south) * M_PER_DEG, 2000, 1, 'south margin (m)');
    assertWithinPct((b.east - -84.38) * mPerDegLon, 2000, 1, 'east margin (m)');
    assertWithinPct((-84.4 - b.west) * mPerDegLon, 2000, 1, 'west margin (m)');
  });

  test('bboxAround clamps latitude to [-90, 90]', () => {
    const n = bboxAround([{ lat: 89.99, lon: 10 }], 5000);
    assert.equal(n.north, 90, 'north clamped');
    assertWithinPct((89.99 - n.south) * M_PER_DEG, 5000, 1, 'south margin near the north pole (m)');
    const s = bboxAround([[-89.99, 10]], 5000);
    assert.equal(s.south, -90, 'south clamped');
    for (const b of [n, s]) {
      assert.ok(b.south >= -90 && b.north <= 90, `lat out of range: ${JSON.stringify(b)}`);
      assert.ok(b.west >= -180 && b.east <= 180, `lon out of range: ${JSON.stringify(b)}`);
      assert.ok(b.west <= 10 && b.east >= 10, `bbox no longer contains the point: ${JSON.stringify(b)}`);
    }
  });

  test('bboxAround clamps longitude to [-180, 180]', () => {
    const e = bboxAround([{ lat: 0, lon: 179.99 }], 5000);
    assert.equal(e.east, 180, 'east clamped');
    assert.ok(e.west < 179.99, `west should grow past the point, got ${e.west}`);
    const w = bboxAround([[0, -179.99]], 5000);
    assert.equal(w.west, -180, 'west clamped');
    assert.ok(w.east > -179.99, `east should grow past the point, got ${w.east}`);
  });

  test('bboxAround throws InputError (code INPUT) for no points', () => {
    assertInputError(() => bboxAround([], 100), 'bboxAround([], 100)');
  });
});

// ---- bboxContains ----

describe('geo: bboxContains', () => {
  const BOX = Object.freeze({ south: 33.7, west: -84.4, north: 33.8, east: -84.3 });

  test('bboxContains is true for a point inside and false for points outside', () => {
    assert.equal(bboxContains(BOX, { lat: 33.75, lon: -84.35 }), true, 'inside');
    assert.equal(bboxContains(BOX, { lat: 33.6999, lon: -84.35 }), false, 'south of the box');
    assert.equal(bboxContains(BOX, { lat: 33.8001, lon: -84.35 }), false, 'north of the box');
    assert.equal(bboxContains(BOX, { lat: 33.75, lon: -84.4001 }), false, 'west of the box');
    assert.equal(bboxContains(BOX, { lat: 33.75, lon: -84.2999 }), false, 'east of the box');
  });

  test('bboxContains counts points on the edges and corners as inside', () => {
    const edges = {
      south: { lat: 33.7, lon: -84.35 },
      north: { lat: 33.8, lon: -84.35 },
      west: { lat: 33.75, lon: -84.4 },
      east: { lat: 33.75, lon: -84.3 },
      'south-west corner': { lat: 33.7, lon: -84.4 },
      'north-east corner': { lat: 33.8, lon: -84.3 },
    };
    for (const [name, p] of Object.entries(edges)) {
      assert.equal(bboxContains(BOX, p), true, `${name} edge point`);
    }
  });
});

// ---- bboxUnion ----

describe('geo: bboxUnion', () => {
  test('bboxUnion is the smallest bbox containing two separate bboxes (either order)', () => {
    const a = { south: 0, west: 0, north: 1, east: 1 };
    const b = { south: 2, west: -3, north: 4, east: 0.5 };
    const expected = { south: 0, west: -3, north: 4, east: 1 };
    assertBBoxClose(bboxUnion(a, b), expected, 0, 'bboxUnion(a, b)');
    assertBBoxClose(bboxUnion(b, a), expected, 0, 'bboxUnion(b, a)');
  });

  test('bboxUnion of a bbox and one inside it is the outer bbox', () => {
    const outer = { south: 33.7, west: -84.4, north: 33.8, east: -84.3 };
    const inner = { south: 33.72, west: -84.38, north: 33.78, east: -84.32 };
    assertBBoxClose(bboxUnion(outer, inner), outer, 0, 'bboxUnion(outer, inner)');
    assertBBoxClose(bboxUnion(inner, outer), outer, 0, 'bboxUnion(inner, outer)');
  });
});

// ---- circleRing ----

describe('geo: circleRing', () => {
  test('circleRing returns sides + 1 positions, last equal to first, with 12 sides by default', () => {
    const ring = circleRing(ATL, 75);
    assert.equal(ring.length, 13, 'default ring length');
    assert.deepEqual(ring.at(-1), ring[0], 'ring is not closed');
  });

  test('circleRing honors a custom number of sides', () => {
    const ring = circleRing(ATL, 75, 8);
    assert.equal(ring.length, 9, 'ring length for 8 sides');
    assert.deepEqual(ring.at(-1), ring[0], 'ring is not closed');
  });

  test('circleRing positions are [lon, lat] (Valhalla/GeoJSON order), not [lat, lon]', () => {
    for (const [i, pos] of circleRing(ATL, 75).entries()) {
      assert.ok(Array.isArray(pos) && pos.length === 2, `position ${i} is not a pair`);
      assertClose(pos[0], ATL.lon, 0.01, `position ${i}[0] should be the longitude`);
      assertClose(pos[1], ATL.lat, 0.01, `position ${i}[1] should be the latitude`);
    }
  });

  test('circleRing vertices are about radiusM from the center and surround it', () => {
    // The JSDoc does not say whether the polygon is inscribed in the circle (vertices at
    // radiusM) or drawn around it (vertices at radiusM / cos(pi / sides)), so both pass,
    // each with 1% slack.
    const radiusM = 300;
    const sides = 16;
    const ring = circleRing(ATL, radiusM, sides);
    const minM = radiusM * 0.99;
    const maxM = (radiusM / Math.cos(Math.PI / sides)) * 1.01;
    const mPerDegLon = M_PER_DEG * Math.cos((ATL.lat * Math.PI) / 180);
    for (const [i, [lon, lat]] of ring.entries()) {
      const d = Math.hypot((lat - ATL.lat) * M_PER_DEG, (lon - ATL.lon) * mPerDegLon);
      assert.ok(d >= minM && d <= maxM, `vertex ${i} distance from center: expected ${minM}..${maxM} m, got ${d}`);
    }
    const lats = ring.map((pos) => pos[1]);
    const lons = ring.map((pos) => pos[0]);
    assert.ok(Math.min(...lats) < ATL.lat && Math.max(...lats) > ATL.lat, 'ring does not surround the center north-south');
    assert.ok(Math.min(...lons) < ATL.lon && Math.max(...lons) > ATL.lon, 'ring does not surround the center east-west');
  });
});

// ---- decodePolyline / encodePolyline ----

// Google's published example (precision 5), and the same points at precision 6.
const GOOGLE_POINTS = [
  [38.5, -120.2],
  [40.7, -120.95],
  [43.252, -126.453],
];
const GOOGLE_P5 = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';
const GOOGLE_P6 = '_izlhA~rlgdF_{geC~ywl@_kwzCn`{nI';

describe('geo: decodePolyline', () => {
  test("decodePolyline decodes Google's published precision-5 example as [lat, lon] pairs", () => {
    assertPairsClose(decodePolyline(GOOGLE_P5, 5), GOOGLE_POINTS, 1e-9, 'decodePolyline(p5)');
  });

  test('decodePolyline defaults to precision 6 (Valhalla)', () => {
    assertPairsClose(decodePolyline(GOOGLE_P6), GOOGLE_POINTS, 1e-9, 'decodePolyline(p6 string)');
  });
});

describe('geo: encodePolyline', () => {
  test("encodePolyline encodes Google's published precision-5 example exactly", () => {
    assert.equal(encodePolyline(GOOGLE_POINTS, 5), GOOGLE_P5);
  });

  test('encodePolyline defaults to precision 6 (Valhalla)', () => {
    assert.equal(encodePolyline(GOOGLE_POINTS), GOOGLE_P6);
  });

  test('decodePolyline(encodePolyline(x, p), p) equals x rounded to p decimals', () => {
    const points = [
      [33.7490123456, -84.3880987654],
      [33.7490123456, -84.3880987654], // repeated point (zero delta)
      [-33.86881234, 151.20931234], // other hemispheres
      [0, 0],
    ];
    assertPairsClose(
      decodePolyline(encodePolyline(points)),
      [
        [33.749012, -84.388099],
        [33.749012, -84.388099],
        [-33.868812, 151.209312],
        [0, 0],
      ],
      1e-9,
      'round trip at default precision 6',
    );
    assertPairsClose(
      decodePolyline(encodePolyline(points, 5), 5),
      [
        [33.74901, -84.3881],
        [33.74901, -84.3881],
        [-33.86881, 151.20931],
        [0, 0],
      ],
      1e-9,
      'round trip at precision 5',
    );
  });

  test('decodePolyline(encodePolyline([])) is an empty line', () => {
    assert.deepEqual(decodePolyline(encodePolyline([])), []);
  });
});
