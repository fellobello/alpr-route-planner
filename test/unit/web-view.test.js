import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  COLORS,
  cameraHits,
  cameraPopup,
  cameraStatus,
  cameraStyle,
  clampBounds,
  clickHint,
  errorMessage,
  mergeCameras,
  sliderStep,
} from '../../public/view.js';
import { bboxParam } from '../../public/lib.js';

const flock = {
  id: 'osm:node/1',
  lat: 33.75,
  lon: -84.39,
  isFlock: true,
  manufacturer: 'Flock Safety',
  operator: 'Atlanta Police Department',
};
const other = { id: 'osm:node/2', lat: 33.76, lon: -84.38, isFlock: false, manufacturer: null, operator: null };
const none = { fastest: false, avoiding: false };

test('clampBounds leaves a small view alone', () => {
  const b = { south: 33.7, west: -84.45, north: 33.8, east: -84.3 };
  assert.deepEqual(clampBounds(b, 0.5), { bounds: b, clipped: false });
});

test('clampBounds shrinks a side wider than the limit around its center', () => {
  const { bounds, clipped } = clampBounds({ south: 33.4, west: -85, north: 34.2, east: -83.6 }, 0.5);
  assert.equal(clipped, true);
  assert.ok(bounds.north - bounds.south < 0.5);
  assert.ok(bounds.east - bounds.west < 0.5);
  assert.ok(Math.abs((bounds.north + bounds.south) / 2 - 33.8) < 1e-9);
  assert.ok(Math.abs((bounds.east + bounds.west) / 2 - -84.3) < 1e-9);
});

test('clampBounds result stays under the limit after bboxParam rounding', () => {
  const { bounds } = clampBounds({ south: 10.123456, west: 20.987654, north: 11.5, east: 23 }, 0.5);
  const [s, w, n, e] = bboxParam(bounds).split(',').map(Number);
  assert.ok(n - s <= 0.5, `lat span ${n - s}`);
  assert.ok(e - w <= 0.5, `lon span ${e - w}`);
});

test('clampBounds clamps wrapped longitudes and polar latitudes', () => {
  const { bounds } = clampBounds({ south: 89.9, west: 179.8, north: 91, east: 180.2 }, 0.5);
  assert.equal(bounds.north, 90);
  assert.equal(bounds.east, 180);
  assert.equal(bounds.west, 179.8);
  assert.equal(bounds.south, 89.9);
});

test('mergeCameras dedupes by id, first list wins, null lists skipped', () => {
  const changed = { ...flock, operator: 'Changed' };
  const out = mergeCameras([flock], null, [changed, other], undefined);
  assert.deepEqual(out, [flock, other]);
});

test('cameraHits reads both sets', () => {
  const hits = { fastest: new Set(['a', 'b']), avoiding: new Set(['b']) };
  assert.deepEqual(cameraHits('a', hits), { fastest: true, avoiding: false });
  assert.deepEqual(cameraHits('b', hits), { fastest: true, avoiding: true });
  assert.deepEqual(cameraHits('c', hits), { fastest: false, avoiding: false });
});

test('cameraStyle: one color for Flock, another for other ALPRs', () => {
  assert.equal(cameraStyle(flock, none).fillColor, COLORS.flock);
  assert.equal(cameraStyle(other, none).fillColor, COLORS.otherAlpr);
  assert.notEqual(COLORS.flock, COLORS.otherAlpr);
  assert.equal(cameraStyle(flock, none).radius, 6);
});

test('cameraStyle highlights cameras next to either route', () => {
  for (const hit of [{ fastest: true, avoiding: false }, { fastest: false, avoiding: true }]) {
    const s = cameraStyle(other, hit);
    assert.equal(s.radius, 9);
    assert.equal(s.color, COLORS.hitOutline);
    assert.equal(s.weight, 3);
    assert.equal(s.fillColor, COLORS.otherAlpr);
  }
});

test('cameraPopup shows manufacturer and operator, "unknown" when missing', () => {
  assert.deepEqual(cameraPopup(flock, none), {
    title: 'Flock ALPR camera',
    rows: [
      ['Manufacturer', 'Flock Safety'],
      ['Operator', 'Atlanta Police Department'],
    ],
  });
  assert.deepEqual(cameraPopup(other, none), {
    title: 'ALPR camera',
    rows: [
      ['Manufacturer', 'unknown'],
      ['Operator', 'unknown'],
    ],
  });
});

test('cameraPopup says which routes pass the camera', () => {
  assert.deepEqual(cameraPopup(other, { fastest: true, avoiding: false }).rows[2], ['Next to', 'fastest route']);
  assert.deepEqual(cameraPopup(other, { fastest: false, avoiding: true }).rows[2], ['Next to', 'avoiding route']);
  assert.deepEqual(cameraPopup(other, { fastest: true, avoiding: true }).rows[2], [
    'Next to',
    'fastest and avoiding routes',
  ]);
});

test('errorMessage uses the API {error} text', () => {
  assert.equal(errorMessage(422, { error: 'Trip is too long.', code: 'TRIP_TOO_LONG' }), 'Trip is too long.');
  assert.equal(errorMessage(502, { error: '  overpass: timeout ', code: 'UPSTREAM' }), 'overpass: timeout');
});

test('errorMessage falls back to the status when there is no usable {error}', () => {
  assert.equal(errorMessage(500, null), 'Request failed (HTTP 500).');
  assert.equal(errorMessage(404, { error: '' }), 'Request failed (HTTP 404).');
  assert.equal(errorMessage(400, { error: 42 }), 'Request failed (HTTP 400).');
  assert.equal(errorMessage(502, 'Bad Gateway'), 'Request failed (HTTP 502).');
});

test('cameraStatus texts', () => {
  const base = { zoom: 13, minZoom: 12, loading: false, count: 5, clipped: false, error: null };
  assert.equal(cameraStatus({ ...base, zoom: 11 }), 'Zoom in to see cameras.');
  assert.equal(cameraStatus({ ...base, zoom: 11, error: 'x' }), 'Zoom in to see cameras.');
  assert.equal(cameraStatus({ ...base, error: 'overpass: timeout' }), 'Could not load cameras: overpass: timeout');
  assert.equal(cameraStatus({ ...base, loading: true }), 'Loading cameras...');
  assert.equal(cameraStatus({ ...base, count: null }), 'Loading cameras...');
  assert.equal(cameraStatus(base), '5 cameras in view.');
  assert.equal(cameraStatus({ ...base, count: 1 }), '1 camera in view.');
  assert.equal(cameraStatus({ ...base, count: 0 }), '0 cameras in view.');
  assert.equal(
    cameraStatus({ ...base, clipped: true }),
    '5 cameras near the center of the view (zoom in to see the edges).',
  );
});

test('clickHint follows the click cycle', () => {
  const p = { lat: 1, lon: 2 };
  assert.equal(clickHint({ start: null, end: null }), 'Click the map to set the start.');
  assert.equal(clickHint({ start: p, end: null }), 'Click the map to set the end.');
  assert.equal(clickHint({ start: p, end: p }), 'Ready. Click the map again to start over.');
});

test('sliderStep is 5 m for round limits, else 1 m', () => {
  assert.equal(sliderStep({ minBufferM: 15, maxBufferM: 300, defaultBufferM: 75 }), 5);
  assert.equal(sliderStep({ minBufferM: 12, maxBufferM: 300, defaultBufferM: 75 }), 1);
  assert.equal(sliderStep({ minBufferM: 15, maxBufferM: 300, defaultBufferM: 72 }), 1);
});

test('view.js has no DOM or Leaflet dependency', async () => {
  const src = await readFile(new URL('../../public/view.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\b(document|window)\b|\bL\./);
  assert.doesNotMatch(src, /^import /m);
});
