// Overpass resilience (mirrors, stale tiles, the tile file), place search, and the shared API core.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

import { OverpassCameraSource } from '../../src/cameras/overpass.js';
import { FileTileStore } from '../../src/cameras/tile-store.js';
import { NominatimGeocoder, buildNominatimUrl, parseNominatim } from '../../src/geocode/nominatim.js';
import { parseCoordinates } from '../../src/geocode/coordinates.js';
import { createApi } from '../../src/api.js';
import { InputError, UpstreamError } from '../../src/types.js';

const BBOX = { south: 35.21, west: -120.69, north: 35.29, east: -120.61 };

/** @param {number} id @param {number} lat @param {number} lon */
const node = (id, lat, lon) => ({ type: 'node', id, lat, lon, tags: { 'surveillance:type': 'ALPR', manufacturer: 'Flock Safety' } });

/**
 * Fake fetch: each call takes the next behavior ("ok" with elements, a status number, "throw",
 * or "hang" until released).
 * @param {any[]} plan
 */
function fakeOverpass(plan) {
  /** @type {string[]} */
  const calls = [];
  /** @type {(() => void)[]} */
  const hanging = [];
  const fetch = async (/** @type {string} */ url) => {
    calls.push(url);
    const step = plan.length > 1 ? plan.shift() : plan[0];
    if (step === 'throw') throw new TypeError('fetch failed');
    if (step === 'hang') await new Promise((r) => hanging.push(() => r(undefined)));
    if (typeof step === 'number') return { ok: false, status: step, statusText: '' };
    const elements = step === 'hang' ? [node(2, 35.25, -120.65)] : step;
    return { ok: true, status: 200, json: async () => ({ elements }) };
  };
  return { fetch, calls, release: () => hanging.splice(0).forEach((r) => r()) };
}

function clock(t = 1_000_000) {
  return { now: () => t, advance: (/** @type {number} */ ms) => (t += ms) };
}

const quiet = () => {
  const warn = console.warn;
  console.warn = () => {};
  return () => (console.warn = warn);
};

test('overpass tries the next mirror when one fails', async () => {
  const restore = quiet();
  try {
    const server = fakeOverpass([502, 'throw', [node(1, 35.25, -120.65)]]);
    const src = new OverpassCameraSource({ fetch: server.fetch, endpoints: ['https://a.test', 'https://b.test', 'https://c.test'] });
    const cams = await src.getCameras(BBOX);
    assert.deepEqual(server.calls, ['https://a.test', 'https://b.test', 'https://c.test']);
    assert.equal(cams.length, 1);
  } finally {
    restore();
  }
});

test('overpass rejects when every mirror fails and nothing is cached', async () => {
  const restore = quiet();
  try {
    const server = fakeOverpass([504]);
    const src = new OverpassCameraSource({ fetch: server.fetch, endpoints: ['https://a.test', 'https://b.test'] });
    await assert.rejects(src.getCameras(BBOX), UpstreamError);
    assert.equal(server.calls.length, 2);
  } finally {
    restore();
  }
});

test('expired tiles are still served when the refresh fails, and retried next time', async () => {
  const c = clock();
  const server = fakeOverpass([[node(1, 35.25, -120.65)], 503, [node(1, 35.25, -120.65), node(3, 35.26, -120.64)]]);
  const src = new OverpassCameraSource({ fetch: server.fetch, now: c.now, ttlMs: 60_000 });
  assert.equal((await src.getCameras(BBOX)).length, 1);
  c.advance(61_000);
  assert.equal((await src.getCameras(BBOX)).length, 1, 'stale data instead of an error');
  assert.equal(server.calls.length, 2);
  assert.equal((await src.getCameras(BBOX)).length, 2, 'next call refreshes');
  assert.equal(server.calls.length, 3);
});

test('a slow refresh answers with stale data and updates the cache when it lands', async () => {
  const c = clock();
  const server = fakeOverpass([[node(1, 35.25, -120.65)], 'hang']);
  const src = new OverpassCameraSource({ fetch: server.fetch, now: c.now, ttlMs: 60_000, staleWaitMs: 5 });
  await src.getCameras(BBOX);
  c.advance(61_000);
  const cams = await src.getCameras(BBOX);
  assert.deepEqual(cams.map((x) => x.id), ['osm:node/1']);
  server.release();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual((await src.getCameras(BBOX)).map((x) => x.id), ['osm:node/2']);
  assert.equal(server.calls.length, 2);
});

test('tiles saved by one source are used by the next without a request', async () => {
  /** @type {any[]} */
  let saved = [];
  const store = { load: () => saved, save: (/** @type {any[]} */ t) => (saved = t) };
  const c = clock();
  const first = new OverpassCameraSource({ fetch: fakeOverpass([[node(1, 35.25, -120.65)]]).fetch, now: c.now, store });
  await first.getCameras(BBOX);
  await new Promise((r) => setImmediate(r));
  assert.ok(saved.length > 0);

  const server = fakeOverpass([500]);
  const second = new OverpassCameraSource({ fetch: server.fetch, now: c.now, store });
  assert.deepEqual((await second.getCameras(BBOX)).map((x) => x.id), ['osm:node/1']);
  assert.equal(server.calls.length, 0);
});

test('a broken store is ignored', async () => {
  const restore = quiet();
  try {
    const store = {
      load: () => {
        throw new Error('disk on fire');
      },
      save: () => {
        throw new Error('still on fire');
      },
    };
    const src = new OverpassCameraSource({ fetch: fakeOverpass([[node(1, 35.25, -120.65)]]).fetch, store });
    assert.equal((await src.getCameras(BBOX)).length, 1);
  } finally {
    restore();
  }
});

test('FileTileStore round-trips tiles through a file and ignores unknown formats', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'alpr-tiles-'));
  try {
    const file = path.join(dir, 'sub', 'tiles.json');
    const store = new FileTileStore(file);
    assert.deepEqual(store.load(), []);
    const tiles = [{ key: '352,-1207', fetchedAt: 5, cameras: [] }];
    store.save(tiles);
    store.flush();
    assert.deepEqual(new FileTileStore(file).load(), tiles);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).format, 1);

    await writeFile(file, JSON.stringify({ format: 99, tiles }));
    assert.deepEqual(new FileTileStore(file).load(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- Place search ----

test('parseCoordinates reads "lat, lon" and refuses anything else', () => {
  assert.deepEqual(parseCoordinates('35.28, -120.66'), { lat: 35.28, lon: -120.66 });
  assert.deepEqual(parseCoordinates(' -33.9 151.2 '), { lat: -33.9, lon: 151.2 });
  assert.equal(parseCoordinates('95, 10'), null);
  assert.equal(parseCoordinates('10, 190'), null);
  assert.equal(parseCoordinates('Main St 12'), null);
});

test('buildNominatimUrl asks for jsonv2 with a limit, biased near a point', () => {
  const url = new URL(buildNominatimUrl('mission plaza', { lat: 35.3, lon: -120.7 }));
  assert.equal(url.origin + url.pathname, 'https://nominatim.openstreetmap.org/search');
  assert.equal(url.searchParams.get('q'), 'mission plaza');
  assert.equal(url.searchParams.get('format'), 'jsonv2');
  assert.equal(url.searchParams.get('limit'), '5');
  assert.equal(url.searchParams.get('viewbox'), '-121.2000,35.8000,-120.2000,34.8000');
  assert.equal(new URL(buildNominatimUrl('x')).searchParams.has('viewbox'), false);
});

test('parseNominatim splits the name from the rest of the address', () => {
  assert.deepEqual(
    parseNominatim([
      { name: 'Mission Plaza', display_name: 'Mission Plaza, San Luis Obispo, California', lat: '35.28', lon: '-120.66' },
      { name: '', display_name: '12 Main St, Town', lat: '1', lon: '2' },
      { name: 'bad', lat: 'x', lon: '2' },
    ]),
    [
      { name: 'Mission Plaza', detail: 'San Luis Obispo, California', lat: 35.28, lon: -120.66 },
      { name: '12 Main St', detail: 'Town', lat: 1, lon: 2 },
    ],
  );
  assert.throws(() => parseNominatim({}), UpstreamError);
});

test('NominatimGeocoder caches, spaces requests a second apart, and does not cache failures', async () => {
  /** @type {string[]} */
  const calls = [];
  /** @type {number[]} */
  const waits = [];
  let fail = false;
  let t = 0;
  const geo = new NominatimGeocoder({
    now: () => t,
    sleep: async (ms) => {
      waits.push(ms);
      t += ms;
    },
    fetch: /** @type {any} */ (
      async (/** @type {string} */ url, /** @type {any} */ init) => {
        calls.push(url);
        assert.match(init.headers['User-Agent'], /^alpr-route-planner\//);
        if (fail) return { ok: false, status: 503 };
        return { ok: true, status: 200, json: async () => [{ name: 'A', display_name: 'A, B', lat: '1', lon: '2' }] };
      }
    ),
  });
  assert.equal((await geo.search('a')).length, 1);
  await geo.search('a');
  assert.equal(calls.length, 1, 'second search came from the cache');
  await geo.search('b');
  assert.deepEqual(waits, [1100]);
  fail = true;
  await assert.rejects(geo.search('c'), UpstreamError);
  fail = false;
  assert.equal((await geo.search('c')).length, 1);
  assert.equal(calls.length, 4);
});

// ---- API core ----

const fakeDeps = () => ({
  cameraSource: { name: 'src', getCameras: async () => [] },
  router: { name: 'rt', maxAvoid: 5, route: async () => ({ points: [], distanceM: 0, durationS: 0 }) },
});

test('api.geocode answers typed coordinates itself and otherwise asks the geocoder', async () => {
  /** @type {any[]} */
  const asked = [];
  const geocoder = { name: 'g', search: async (/** @type {string} */ q, /** @type {any} */ near) => (asked.push([q, near]), []) };
  const api = createApi({ ...fakeDeps(), geocoder });
  assert.deepEqual(await api.geocode('35.1, -120.2', null), {
    results: [{ name: '35.10000, -120.20000', detail: 'Coordinates', lat: 35.1, lon: -120.2 }],
  });
  assert.equal(asked.length, 0);
  await api.geocode('  pismo beach ', '35.2,-120.6');
  assert.deepEqual(asked, [['pismo beach', { lat: 35.2, lon: -120.6 }]]);
  await assert.rejects(api.geocode('', null), InputError);
  await assert.rejects(api.geocode('x'.repeat(201), null), InputError);
  assert.equal((await api.config()).geocoder, 'g');
});

test('api without a geocoder only reads coordinates', async () => {
  const api = createApi(fakeDeps());
  assert.deepEqual(await api.geocode('pismo beach', null), { results: [] });
  assert.equal((await api.config()).geocoder, 'coordinates');
});
