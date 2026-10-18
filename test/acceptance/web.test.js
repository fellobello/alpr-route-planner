// Acceptance tests for the web module's pure helpers in public/lib.js.
// Written from .hub/spec.md and the JSDoc in public/lib.js only (not from the implementation).
// No DOM, no network: lib.js promises it is importable by Node.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  bboxParam,
  formatDistance,
  formatDuration,
  nextClickState,
  buildRouteRequest,
  summarizePlan,
} from '../../public/lib.js';

// ---------- module ----------

test('lib.js: imports in plain Node (no DOM) and exports the six helpers', async () => {
  assert.equal(typeof globalThis.document, 'undefined');
  const lib = await import('../../public/lib.js');
  for (const name of [
    'bboxParam',
    'formatDistance',
    'formatDuration',
    'nextClickState',
    'buildRouteRequest',
    'summarizePlan',
  ]) {
    assert.equal(typeof lib[name], 'function', `${name} should be an exported function`);
  }
});

// ---------- bboxParam ----------

test('bboxParam: joins values as "south,west,north,east" in that order', () => {
  // Keys deliberately listed in a different order than the output.
  const bounds = { east: -84.3, north: 33.8, west: -84.4, south: 33.7 };
  assert.equal(bboxParam(bounds), '33.7,-84.4,33.8,-84.3');
});

test('bboxParam: rounds each value to 5 decimals', () => {
  const bounds = { south: 33.123456789, west: -84.987654321, north: 33.200004, east: -84.100006 };
  assert.equal(bboxParam(bounds), '33.12346,-84.98765,33.2,-84.10001');
});

test('bboxParam: drops trailing zeros (integers and values that round to fewer decimals)', () => {
  const bounds = { south: 33, west: -84.5, north: 33.9999999, east: -84.0000001 };
  assert.equal(bboxParam(bounds), '33,-84.5,34,-84');
});

// ---------- formatDistance ----------

test('formatDistance: under 1000 m gives "<rounded> m"', () => {
  assert.equal(formatDistance(850), '850 m');
  assert.equal(formatDistance(849.6), '850 m');
  assert.equal(formatDistance(12.2), '12 m');
  assert.equal(formatDistance(0), '0 m');
  assert.equal(formatDistance(999), '999 m');
});

test('formatDistance: 1000 m and over gives km with one decimal', () => {
  assert.equal(formatDistance(3400), '3.4 km');
  assert.equal(formatDistance(3421), '3.4 km');
  assert.equal(formatDistance(12345), '12.3 km');
  assert.equal(formatDistance(49870), '49.9 km');
});

test('formatDistance: exactly 1000 m switches to km and keeps the one decimal ("1.0 km")', () => {
  assert.equal(formatDistance(1000), '1.0 km');
  assert.equal(formatDistance(2000), '2.0 km');
});

// ---------- formatDuration ----------

test('formatDuration: under 30 s gives "<1 min"', () => {
  assert.equal(formatDuration(0), '<1 min');
  assert.equal(formatDuration(1), '<1 min');
  assert.equal(formatDuration(29), '<1 min');
  assert.equal(formatDuration(29.9), '<1 min');
});

test('formatDuration: from 30 s, rounded minutes under 60 give "<m> min"', () => {
  assert.equal(formatDuration(30), '1 min'); // Math.round(0.5) = 1
  assert.equal(formatDuration(89), '1 min');
  assert.equal(formatDuration(90), '2 min');
  assert.equal(formatDuration(720), '12 min');
  assert.equal(formatDuration(3569), '59 min'); // 59.48 -> 59
});

test('formatDuration: 60 rounded minutes and over give "<h> h <rest> min"', () => {
  assert.equal(formatDuration(3900), '1 h 5 min');
  assert.equal(formatDuration(9000), '2 h 30 min');
  assert.equal(formatDuration(7260), '2 h 1 min');
});

test('formatDuration: whole hours keep the minutes part ("1 h 0 min"), including 59.5 min rounding up', () => {
  assert.equal(formatDuration(3600), '1 h 0 min');
  assert.equal(formatDuration(3570), '1 h 0 min'); // 59.5 rounds to 60 minutes
});

// ---------- nextClickState ----------

const A = { lat: 33.75, lon: -84.39 };
const B = { lat: 33.77, lon: -84.36 };
const C = { lat: 33.74, lon: -84.41 };

test('nextClickState: with no start, the click sets the start', () => {
  const next = nextClickState({ start: null, end: null }, A);
  assert.deepEqual(next, { start: A, end: null });
});

test('nextClickState: with a start but no end, the click sets the end and keeps the start', () => {
  const next = nextClickState({ start: A, end: null }, B);
  assert.deepEqual(next, { start: A, end: B });
});

test('nextClickState: with both set, the click becomes the new start and the end is cleared', () => {
  const next = nextClickState({ start: A, end: B }, C);
  assert.deepEqual(next, { start: C, end: null });
});

test('nextClickState: returns a new object and leaves the input state unchanged', () => {
  const states = [
    { start: null, end: null },
    { start: A, end: null },
    { start: A, end: B },
  ];
  for (const state of states) {
    const before = structuredClone(state);
    const next = nextClickState(state, C);
    assert.notEqual(next, state, 'should return a new object');
    assert.deepEqual(state, before, 'input state should not be mutated');
  }
});

// ---------- buildRouteRequest ----------

test('buildRouteRequest: builds {start, end, bufferM} for POST /api/route', () => {
  const body = buildRouteRequest(A, B, 75);
  assert.deepEqual(body, { start: A, end: B, bufferM: 75 });
});

test('buildRouteRequest: copies only lat and lon from the points', () => {
  const start = { lat: 33.75, lon: -84.39, lng: -84.39, alt: 300, label: 'start' };
  const end = { lat: 33.77, lon: -84.36, extra: { nested: true } };
  const body = buildRouteRequest(start, end, 150);
  assert.deepEqual(body, {
    start: { lat: 33.75, lon: -84.39 },
    end: { lat: 33.77, lon: -84.36 },
    bufferM: 150,
  });
  // The request must survive a JSON round trip unchanged (it is sent as a JSON body).
  assert.deepEqual(JSON.parse(JSON.stringify(body)), body);
});

// ---------- summarizePlan ----------

/**
 * A RoutePlan shaped like the response of POST /api/route (src/types.js).
 * @param {object} [o]
 */
function makePlan(o = {}) {
  const {
    fastestPoints = [[33.75, -84.39], [33.76, -84.385], [33.77, -84.36]],
    fastestDistanceM = 3400,
    fastestDurationS = 720,
    fastestIds = ['sample:1', 'sample:2'],
    avoidingPoints = [[33.75, -84.39], [33.755, -84.37], [33.77, -84.36]],
    avoidingDistanceM = 4200,
    avoidingDurationS = 900,
    avoidingIds = [],
    notes = [],
  } = o;
  return {
    fastest: {
      route: { points: fastestPoints, distanceM: fastestDistanceM, durationS: fastestDurationS },
      cameraIds: fastestIds,
    },
    avoiding: {
      route: { points: avoidingPoints, distanceM: avoidingDistanceM, durationS: avoidingDurationS },
      cameraIds: avoidingIds,
    },
    cameras: [
      { id: 'sample:1', lat: 33.76, lon: -84.385, isFlock: true, manufacturer: 'Flock Safety', operator: null, direction: null, source: 'sample' },
      { id: 'sample:2', lat: 33.765, lon: -84.372, isFlock: false, manufacturer: null, operator: 'City', direction: 90, source: 'sample' },
    ],
    bufferM: 75,
    iterations: 1,
    notes,
  };
}

test('summarizePlan: fastest and avoiding get distance, duration and camera texts', () => {
  const s = summarizePlan(makePlan());
  assert.equal(s.fastest.distanceText, '3.4 km');
  assert.equal(s.fastest.durationText, '12 min');
  assert.equal(s.fastest.cameraCount, 2);
  assert.equal(s.fastest.cameraText, '2 cameras');

  assert.equal(s.avoiding.distanceText, '4.2 km');
  assert.equal(s.avoiding.durationText, '15 min');
  assert.equal(s.avoiding.cameraCount, 0);
  assert.equal(s.avoiding.cameraText, 'No cameras');
});

test('summarizePlan: texts use formatDistance and formatDuration (metres and hours)', () => {
  const s = summarizePlan(
    makePlan({ fastestDistanceM: 850, fastestDurationS: 20, avoidingDistanceM: 45200, avoidingDurationS: 3900 }),
  );
  assert.equal(s.fastest.distanceText, '850 m');
  assert.equal(s.fastest.durationText, '<1 min');
  assert.equal(s.avoiding.distanceText, '45.2 km');
  assert.equal(s.avoiding.durationText, '1 h 5 min');
});

test('summarizePlan: cameraText is "No cameras" | "1 camera" | "<n> cameras"', () => {
  const zero = summarizePlan(makePlan({ fastestIds: [], avoidingIds: [] }));
  assert.equal(zero.fastest.cameraCount, 0);
  assert.equal(zero.fastest.cameraText, 'No cameras');

  const one = summarizePlan(makePlan({ fastestIds: ['sample:1'], avoidingIds: ['sample:2'] }));
  assert.equal(one.fastest.cameraCount, 1);
  assert.equal(one.fastest.cameraText, '1 camera');
  assert.equal(one.avoiding.cameraCount, 1);
  assert.equal(one.avoiding.cameraText, '1 camera');

  const ids = ['sample:1', 'sample:2', 'sample:3', 'sample:4', 'sample:5', 'sample:6', 'sample:7', 'sample:8', 'sample:9', 'sample:10', 'sample:11', 'sample:12'];
  const many = summarizePlan(makePlan({ fastestIds: ids, avoidingIds: ids.slice(0, 3) }));
  assert.equal(many.fastest.cameraCount, 12);
  assert.equal(many.fastest.cameraText, '12 cameras');
  assert.equal(many.avoiding.cameraCount, 3);
  assert.equal(many.avoiding.cameraText, '3 cameras');
});

test('summarizePlan: extraText is "+" + formatDuration(avoiding - fastest) when the difference is 30 s or more', () => {
  assert.equal(summarizePlan(makePlan({ fastestDurationS: 720, avoidingDurationS: 900 })).avoiding.extraText, '+3 min');
  assert.equal(summarizePlan(makePlan({ fastestDurationS: 600, avoidingDurationS: 630 })).avoiding.extraText, '+1 min');
  assert.equal(summarizePlan(makePlan({ fastestDurationS: 600, avoidingDurationS: 4500 })).avoiding.extraText, '+1 h 5 min');
});

test('summarizePlan: extraText is "no extra time" when the avoiding route is less than 30 s slower', () => {
  assert.equal(summarizePlan(makePlan({ fastestDurationS: 720, avoidingDurationS: 749 })).avoiding.extraText, 'no extra time');
  assert.equal(summarizePlan(makePlan({ fastestDurationS: 720, avoidingDurationS: 720 })).avoiding.extraText, 'no extra time');
  // Avoiding route faster than "fastest" (negative difference) is still under 30 s.
  assert.equal(summarizePlan(makePlan({ fastestDurationS: 720, avoidingDurationS: 600 })).avoiding.extraText, 'no extra time');
});

test('summarizePlan: same is true when both routes have identical points (separate arrays, as parsed from JSON)', () => {
  const points = [[33.75, -84.39], [33.76, -84.385], [33.77, -84.36]];
  const plan = makePlan({
    fastestPoints: structuredClone(points),
    avoidingPoints: structuredClone(points),
    fastestIds: [],
    avoidingIds: [],
    avoidingDistanceM: 3400,
    avoidingDurationS: 720,
  });
  const s = summarizePlan(JSON.parse(JSON.stringify(plan)));
  assert.equal(s.same, true);
  assert.equal(s.avoiding.extraText, 'no extra time');
});

test('summarizePlan: same is false when the routes differ in any point or in length', () => {
  assert.equal(summarizePlan(makePlan()).same, false);

  const base = [[33.75, -84.39], [33.76, -84.385], [33.77, -84.36]];
  const oneCoordOff = [[33.75, -84.39], [33.76, -84.38501], [33.77, -84.36]];
  assert.equal(summarizePlan(makePlan({ fastestPoints: base, avoidingPoints: oneCoordOff })).same, false);

  const longer = [...base, [33.78, -84.35]];
  assert.equal(summarizePlan(makePlan({ fastestPoints: base, avoidingPoints: longer })).same, false);
});

test('summarizePlan: notes are passed through from the plan', () => {
  const notes = ["1 camera is next to your start and can't be avoided", 'Another note'];
  const s = summarizePlan(makePlan({ notes: [...notes] }));
  assert.deepEqual(s.notes, notes);

  assert.deepEqual(summarizePlan(makePlan({ notes: [] })).notes, []);
});

test('summarizePlan: does not modify the plan it is given', () => {
  const plan = makePlan({ notes: ['a note'] });
  const before = structuredClone(plan);
  summarizePlan(plan);
  assert.deepEqual(plan, before);
});
