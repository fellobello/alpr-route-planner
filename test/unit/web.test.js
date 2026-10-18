import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bboxParam,
  buildRouteRequest,
  formatDistance,
  formatDuration,
  nextClickState,
  summarizePlan,
} from '../../public/lib.js';

test('bboxParam joins south,west,north,east rounded to 5 decimals without trailing zeros', () => {
  assert.equal(bboxParam({ south: 33.7, west: -84.4, north: 33.8, east: -84.3 }), '33.7,-84.4,33.8,-84.3');
  assert.equal(
    bboxParam({ south: 33.123456789, west: -84.987654321, north: 34, east: -84.000001 }),
    '33.12346,-84.98765,34,-84',
  );
  assert.equal(bboxParam({ south: 1.10000, west: 2.5, north: 3.120004, east: 4.999996 }), '1.1,2.5,3.12,5');
  assert.equal(bboxParam({ south: -0.000001, west: 0, north: 0.000004, east: 0.000006 }), '0,0,0,0.00001');
});

test('bboxParam ignores extra fields and keeps the order', () => {
  const out = bboxParam(/** @type {any} */ ({ east: 4, north: 3, west: 2, south: 1, extra: 9 }));
  assert.equal(out, '1,2,3,4');
});

test('formatDistance uses rounded meters under 1000 m', () => {
  assert.equal(formatDistance(0), '0 m');
  assert.equal(formatDistance(850), '850 m');
  assert.equal(formatDistance(849.6), '850 m');
  assert.equal(formatDistance(12.4), '12 m');
  assert.equal(formatDistance(999.4), '999 m');
});

test('formatDistance uses km with one decimal from 1000 m', () => {
  assert.equal(formatDistance(1000), '1.0 km');
  assert.equal(formatDistance(3400), '3.4 km');
  assert.equal(formatDistance(3449), '3.4 km');
  assert.equal(formatDistance(12_960), '13.0 km');
  assert.equal(formatDistance(50_000), '50.0 km');
});

test('formatDuration under 30 s is "<1 min"', () => {
  assert.equal(formatDuration(0), '<1 min');
  assert.equal(formatDuration(29.9), '<1 min');
});

test('formatDuration rounds to minutes under an hour', () => {
  assert.equal(formatDuration(30), '1 min');
  assert.equal(formatDuration(89), '1 min');
  assert.equal(formatDuration(90), '2 min');
  assert.equal(formatDuration(720), '12 min');
  assert.equal(formatDuration(3569), '59 min');
});

test('formatDuration shows hours and minutes from 60 rounded minutes', () => {
  assert.equal(formatDuration(3570), '1 h 0 min');
  assert.equal(formatDuration(3600), '1 h 0 min');
  assert.equal(formatDuration(3900), '1 h 5 min');
  assert.equal(formatDuration(2 * 3600 + 59 * 60), '2 h 59 min');
  assert.equal(formatDuration(10 * 3600 + 60), '10 h 1 min');
});

test('nextClickState cycles start, end, then a new start', () => {
  const a = { lat: 1, lon: 2 };
  const b = { lat: 3, lon: 4 };
  const c = { lat: 5, lon: 6 };
  const empty = { start: null, end: null };

  const s1 = nextClickState(empty, a);
  assert.deepEqual(s1, { start: a, end: null });
  const s2 = nextClickState(s1, b);
  assert.deepEqual(s2, { start: a, end: b });
  const s3 = nextClickState(s2, c);
  assert.deepEqual(s3, { start: c, end: null });
});

test('nextClickState returns a new object and leaves the input alone', () => {
  const state = { start: { lat: 1, lon: 2 }, end: null };
  const before = structuredClone(state);
  const next = nextClickState(state, { lat: 3, lon: 4 });
  assert.notEqual(next, state);
  assert.deepEqual(state, before);
});

test('nextClickState with only an end set (unexpected) sets the start and keeps the end', () => {
  const end = { lat: 3, lon: 4 };
  const p = { lat: 1, lon: 2 };
  assert.deepEqual(nextClickState({ start: null, end }, p), { start: p, end });
});

test('nextClickState treats a missing end as null', () => {
  const p = { lat: 1, lon: 2 };
  assert.deepEqual(nextClickState(/** @type {any} */ ({ start: null }), p), { start: p, end: null });
});

test('buildRouteRequest copies only lat/lon', () => {
  const start = /** @type {any} */ ({ lat: 33.75, lon: -84.39, lng: -84.39, name: 'x' });
  const end = /** @type {any} */ ({ lat: 33.8, lon: -84.3, alt: 5 });
  const body = buildRouteRequest(start, end, 75);
  assert.deepEqual(body, {
    start: { lat: 33.75, lon: -84.39 },
    end: { lat: 33.8, lon: -84.3 },
    bufferM: 75,
  });
  assert.notEqual(body.start, start);
  assert.notEqual(body.end, end);
  assert.deepEqual(Object.keys(body), ['start', 'end', 'bufferM']);
});

/**
 * @param {Partial<{fastestPoints: number[][], avoidingPoints: number[][], fastestIds: string[], avoidingIds: string[], fastestS: number, avoidingS: number, fastestM: number, avoidingM: number, notes: string[]}>} o
 */
function makePlan(o = {}) {
  const fastestPoints = o.fastestPoints ?? [[33.7, -84.4], [33.8, -84.3]];
  return {
    fastest: {
      route: { points: fastestPoints, distanceM: o.fastestM ?? 3400, durationS: o.fastestS ?? 720 },
      cameraIds: o.fastestIds ?? ['osm:node/1', 'osm:node/2'],
    },
    avoiding: {
      route: {
        points: o.avoidingPoints ?? [[33.7, -84.4], [33.75, -84.38], [33.8, -84.3]],
        distanceM: o.avoidingM ?? 4100,
        durationS: o.avoidingS ?? 900,
      },
      cameraIds: o.avoidingIds ?? [],
    },
    cameras: [],
    bufferM: 75,
    iterations: 1,
    notes: o.notes ?? [],
  };
}

test('summarizePlan formats both routes', () => {
  const s = summarizePlan(makePlan());
  assert.deepEqual(s, {
    fastest: { distanceText: '3.4 km', durationText: '12 min', cameraCount: 2, cameraText: '2 cameras' },
    avoiding: {
      distanceText: '4.1 km',
      durationText: '15 min',
      cameraCount: 0,
      cameraText: 'No cameras',
      extraText: '+3 min',
    },
    same: false,
    notes: [],
  });
});

test('summarizePlan cameraText: No cameras, 1 camera, n cameras', () => {
  assert.equal(summarizePlan(makePlan({ fastestIds: [] })).fastest.cameraText, 'No cameras');
  assert.equal(summarizePlan(makePlan({ fastestIds: ['a'] })).fastest.cameraText, '1 camera');
  assert.equal(summarizePlan(makePlan({ avoidingIds: ['a'] })).avoiding.cameraText, '1 camera');
  assert.equal(summarizePlan(makePlan({ avoidingIds: ['a', 'b', 'c'] })).avoiding.cameraText, '3 cameras');
  assert.equal(summarizePlan(makePlan({ avoidingIds: ['a', 'b', 'c'] })).avoiding.cameraCount, 3);
});

test('summarizePlan extraText: under 30 s extra is "no extra time"', () => {
  assert.equal(summarizePlan(makePlan({ fastestS: 600, avoidingS: 600 })).avoiding.extraText, 'no extra time');
  assert.equal(summarizePlan(makePlan({ fastestS: 600, avoidingS: 629 })).avoiding.extraText, 'no extra time');
  assert.equal(summarizePlan(makePlan({ fastestS: 600, avoidingS: 500 })).avoiding.extraText, 'no extra time');
  assert.equal(summarizePlan(makePlan({ fastestS: 600, avoidingS: 630 })).avoiding.extraText, '+1 min');
  assert.equal(summarizePlan(makePlan({ fastestS: 600, avoidingS: 600 + 3900 })).avoiding.extraText, '+1 h 5 min');
});

test('summarizePlan fastest has no extraText', () => {
  assert.equal('extraText' in summarizePlan(makePlan()).fastest, false);
});

test('summarizePlan same is true only for identical points', () => {
  const pts = [[33.7, -84.4], [33.75, -84.35], [33.8, -84.3]];
  assert.equal(summarizePlan(makePlan({ fastestPoints: pts, avoidingPoints: structuredClone(pts) })).same, true);
  assert.equal(summarizePlan(makePlan({ fastestPoints: pts, avoidingPoints: pts })).same, true);
  assert.equal(
    summarizePlan(makePlan({ fastestPoints: pts, avoidingPoints: [[33.7, -84.4], [33.75, -84.35], [33.8, -84.30001]] }))
      .same,
    false,
  );
  assert.equal(summarizePlan(makePlan({ fastestPoints: pts, avoidingPoints: pts.slice(0, 2) })).same, false);
});

test('summarizePlan passes notes through as a copy', () => {
  const notes = ['1 camera next to your start or end can\'t be avoided.', 'No other route was found.'];
  const plan = makePlan({ notes });
  const s = summarizePlan(plan);
  assert.deepEqual(s.notes, notes);
  assert.notEqual(s.notes, plan.notes);
});

test('summarizePlan of a plan without notes gives []', () => {
  const plan = /** @type {any} */ (makePlan());
  delete plan.notes;
  assert.deepEqual(summarizePlan(plan).notes, []);
});

test('lib.js has no DOM or Leaflet dependency', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../../public/lib.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\b(document|window|L\.)\b/);
  assert.doesNotMatch(src, /^import /m);
});
