// Acceptance tests for the cameras module: src/cameras/overpass.js and src/cameras/fixture.js.
//
// Written only from .hub/spec.md and the interface JSDoc (src/types.js, src/cameras/*.js),
// not from the implementation. Each test name states the promise it checks.
// No network: Overpass is a fake `fetch` that answers from an in-memory list of nodes.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  OVERPASS_ENDPOINT,
  TILE_DEG,
  buildOverpassQuery,
  parseOverpass,
  OverpassCameraSource,
} from '../../src/cameras/overpass.js';
import {
  SAMPLE_CAMERAS_PATH,
  loadSampleCameras,
  FixtureCameraSource,
} from '../../src/cameras/fixture.js';
import {
  CAMERA_CACHE_TTL_MS,
  USER_AGENT,
  InputError,
  UpstreamError,
} from '../../src/types.js';

const FIXTURES = new URL('../fixtures/cameras/', import.meta.url);
const SAMPLE_FILE = new URL('../../data/sample-cameras.json', import.meta.url);
const EPS = 1e-6;

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** The documented Camera fields only, so extra properties on a result don't matter. */
function cameraFields(c) {
  const { id, lat, lon, isFlock, manufacturer, operator, direction, source } = c;
  return { id, lat, lon, isFlock, manufacturer, operator, direction, source };
}

/** An Overpass node tagged as an ALPR, with extra tags merged in. */
function alprNode(id, lat, lon, tags = {}) {
  return { type: 'node', id, lat, lon, tags: { 'surveillance:type': 'ALPR', ...tags } };
}

/** Parse one ALPR node with the given extra tags and return the single resulting Camera. */
function parseOne(tags) {
  const cams = parseOverpass({ elements: [alprNode(1, 33.75, -84.39, tags)] });
  assert.equal(cams.length, 1, 'expected exactly one camera');
  return cams[0];
}

/** The bbox an Overpass query uses: the first four comma-separated numbers (south,west,north,east). */
function bboxFromQuery(query) {
  const num = '(-?\\d+(?:\\.\\d+)?)';
  const sep = '\\s*,\\s*';
  const m = new RegExp(`${num}${sep}${num}${sep}${num}${sep}${num}`).exec(String(query));
  assert.ok(m, `no south,west,north,east bbox found in Overpass query: ${query}`);
  const [south, west, north, east] = m.slice(1, 5).map(Number);
  return { south, west, north, east };
}

function inBbox(bbox, lat, lon, eps = 0) {
  return (
    lat >= bbox.south - eps &&
    lat <= bbox.north + eps &&
    lon >= bbox.west - eps &&
    lon <= bbox.east + eps
  );
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * A fake Overpass server. Each POST is answered with the nodes (from the live `nodes` array,
 * so tests may change it) that fall inside the query's bbox, edges inclusive.
 * Every call is recorded with its url, init, raw body, decoded query and parsed bbox.
 */
function fakeOverpass(nodes) {
  const calls = [];
  async function fetch(url, init = {}) {
    const body = String(init.body ?? '');
    const query = new URLSearchParams(body).get('data') ?? '';
    const bbox = bboxFromQuery(query);
    calls.push({ url: String(url), init, body, query, bbox });
    return jsonResponse({
      version: 0.6,
      generator: 'fake overpass',
      elements: nodes.filter((n) => inBbox(bbox, n.lat, n.lon, EPS)),
    });
  }
  return { fetch, calls };
}

/** A settable clock for the `now` option. */
function fakeClock(start = 1_760_000_000_000) {
  const clock = { t: start, now: () => clock.t };
  return clock;
}

function ids(cameras) {
  return cameras.map((c) => c.id);
}

function sortedIds(cameras) {
  return ids(cameras).sort();
}

/** Assert that `promise` rejects with UpstreamError from the "overpass" service. */
async function assertOverpassUpstreamError(promise) {
  await assert.rejects(promise, (err) => {
    assert.ok(
      err instanceof UpstreamError,
      `expected UpstreamError, got ${err?.name}: ${err?.message}`,
    );
    assert.equal(err.code, 'UPSTREAM');
    assert.equal(err.service, 'overpass');
    return true;
  });
}

function assertInputError(fn) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof InputError, `expected InputError, got ${err?.name}: ${err?.message}`);
    assert.equal(err.code, 'INPUT');
    return true;
  });
}

function readSampleFile() {
  assert.ok(existsSync(SAMPLE_FILE), 'data/sample-cameras.json does not exist');
  return JSON.parse(readFileSync(SAMPLE_FILE, 'utf8'));
}

// One tile on the 0.1-degree grid: lat 33.7..33.8, lon -84.4..-84.3 (central Atlanta).
// This bbox sits inside it, away from tile edges.
const ONE_TILE_BBOX = Object.freeze({ south: 33.72, west: -84.38, north: 33.78, east: -84.32 });

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

describe('cameras: documented constants', () => {
  test('OVERPASS_ENDPOINT is https://overpass-api.de/api/interpreter', () => {
    assert.equal(OVERPASS_ENDPOINT, 'https://overpass-api.de/api/interpreter');
  });

  test('TILE_DEG (cache tile size) is 0.1 degrees', () => {
    assert.equal(TILE_DEG, 0.1);
  });

  test('SAMPLE_CAMERAS_PATH points at data/sample-cameras.json in the project root', () => {
    assert.equal(fileURLToPath(SAMPLE_CAMERAS_PATH), fileURLToPath(SAMPLE_FILE));
  });
});

// ---------------------------------------------------------------------------------------------
// buildOverpassQuery
// ---------------------------------------------------------------------------------------------

describe('buildOverpassQuery', () => {
  // Distinct values so a swapped order is caught.
  const bbox = { south: 33.71, west: -84.42, north: 33.79, east: -84.31 };

  test('query starts with [out:json]', () => {
    assert.ok(
      buildOverpassQuery(bbox).startsWith('[out:json]'),
      `query does not start with [out:json]: ${buildOverpassQuery(bbox)}`,
    );
  });

  test('query includes a [timeout:N] setting', () => {
    assert.match(buildOverpassQuery(bbox), /\[timeout:\d+\]/);
  });

  test('query selects nodes tagged surveillance:type=ALPR', () => {
    const q = buildOverpassQuery(bbox);
    // Overpass QL allows filters in any order and either quote style, so only check the parts.
    assert.match(q, /\bnode\b/, 'query does not select nodes');
    assert.match(
      q,
      /\[\s*["']?surveillance:type["']?\s*=\s*["']?ALPR["']?\s*\]/,
      'query lacks a surveillance:type=ALPR filter',
    );
  });

  test('query uses the bbox in Overpass order (south,west,north,east)', () => {
    const got = bboxFromQuery(buildOverpassQuery(bbox));
    for (const k of ['south', 'west', 'north', 'east']) {
      assert.ok(Math.abs(got[k] - bbox[k]) < EPS, `${k}: expected ${bbox[k]}, query has ${got[k]}`);
    }
  });

  test('query ends with "out body;"', () => {
    assert.ok(
      buildOverpassQuery(bbox).trimEnd().endsWith('out body;'),
      `query does not end with "out body;": ${buildOverpassQuery(bbox)}`,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// parseOverpass
// ---------------------------------------------------------------------------------------------

describe('parseOverpass', () => {
  test('maps an ALPR node to a Camera: id "osm:node/<id>", lat, lon, tags, source "osm"', () => {
    const cams = parseOverpass({
      version: 0.6,
      elements: [
        alprNode(123456789, 33.7756, -84.3963, {
          manufacturer: 'Flock Safety',
          operator: 'Atlanta Police Department',
          direction: '180',
        }),
      ],
    });
    assert.deepEqual(cams.map(cameraFields), [
      {
        id: 'osm:node/123456789',
        lat: 33.7756,
        lon: -84.3963,
        isFlock: true,
        manufacturer: 'Flock Safety',
        operator: 'Atlanta Police Department',
        direction: 180,
        source: 'osm',
      },
    ]);
  });

  test('manufacturer and operator are null when those tags are absent', () => {
    const cam = parseOne({});
    assert.equal(cam.manufacturer, null);
    assert.equal(cam.operator, null);
  });

  test('keeps only elements of type "node"', () => {
    const tags = { 'surveillance:type': 'ALPR' };
    const cams = parseOverpass({
      elements: [
        { type: 'way', id: 10, lat: 33.75, lon: -84.39, tags },
        { type: 'relation', id: 11, lat: 33.75, lon: -84.39, tags },
        { type: 'node', id: 12, lat: 33.75, lon: -84.39, tags },
      ],
    });
    assert.deepEqual(ids(cams), ['osm:node/12']);
  });

  test('drops nodes without numeric lat and lon', () => {
    const tags = { 'surveillance:type': 'ALPR' };
    const cams = parseOverpass({
      elements: [
        { type: 'node', id: 20, lon: -84.39, tags },
        { type: 'node', id: 21, lat: 33.75, tags },
        { type: 'node', id: 22, lat: '33.75', lon: -84.39, tags },
        { type: 'node', id: 23, lat: 33.75, lon: '-84.39', tags },
        { type: 'node', id: 24, lat: 33.75, lon: -84.39, tags },
      ],
    });
    assert.deepEqual(ids(cams), ['osm:node/24']);
  });

  test('keeps only nodes whose surveillance:type is exactly "ALPR"', () => {
    const cams = parseOverpass({
      elements: [
        { type: 'node', id: 30, lat: 33.75, lon: -84.39 },
        { type: 'node', id: 31, lat: 33.75, lon: -84.39, tags: {} },
        { type: 'node', id: 32, lat: 33.75, lon: -84.39, tags: { 'surveillance:type': 'camera' } },
        { type: 'node', id: 33, lat: 33.75, lon: -84.39, tags: { 'surveillance:type': 'alpr' } },
        { type: 'node', id: 34, lat: 33.75, lon: -84.39, tags: { surveillance: 'public' } },
        alprNode(35, 33.75, -84.39),
      ],
    });
    assert.deepEqual(ids(cams), ['osm:node/35']);
  });

  test('isFlock is true when the manufacturer tag contains "flock" in any case', () => {
    assert.equal(parseOne({ manufacturer: 'Flock Safety' }).isFlock, true);
    assert.equal(parseOne({ manufacturer: 'FLOCK' }).isFlock, true);
    assert.equal(parseOne({ manufacturer: 'flock safety inc.' }).isFlock, true);
  });

  test('isFlock is true when the brand tag contains "flock", even with another manufacturer', () => {
    assert.equal(parseOne({ brand: 'Flock Safety' }).isFlock, true);
    assert.equal(parseOne({ brand: 'Flock', manufacturer: 'Acme Optics' }).isFlock, true);
  });

  test('isFlock is false for other makers and when no manufacturer or brand is tagged', () => {
    assert.equal(parseOne({ manufacturer: 'Motorola Solutions' }).isFlock, false);
    assert.equal(parseOne({ brand: 'Vigilant' }).isFlock, false);
    assert.equal(parseOne({ operator: 'Flock-free Town PD' }).isFlock, false);
    assert.equal(parseOne({}).isFlock, false);
  });

  test('direction is the number in tags.direction, including 0', () => {
    assert.equal(parseOne({ direction: '90' }).direction, 90);
    assert.equal(parseOne({ direction: '0' }).direction, 0);
  });

  test('direction takes the first number of a list such as "90;270"', () => {
    assert.equal(parseOne({ direction: '90;270' }).direction, 90);
  });

  test('direction falls back to tags["camera:direction"]', () => {
    assert.equal(parseOne({ 'camera:direction': '180' }).direction, 180);
  });

  test('direction prefers tags.direction over tags["camera:direction"]', () => {
    assert.equal(parseOne({ direction: '90', 'camera:direction': '180' }).direction, 90);
  });

  test('direction turns cardinal letters into degrees (N -> 0, NE -> 45, SW -> 225)', () => {
    assert.equal(parseOne({ direction: 'N' }).direction, 0);
    assert.equal(parseOne({ direction: 'NE' }).direction, 45);
    assert.equal(parseOne({ direction: 'SW' }).direction, 225);
  });

  test('direction is null when absent or unparseable', () => {
    assert.equal(parseOne({}).direction, null);
    assert.equal(parseOne({ direction: 'forward' }).direction, null);
  });

  test('returns [] for an empty elements array', () => {
    assert.deepEqual(parseOverpass({ elements: [] }), []);
  });

  test('throws UpstreamError("overpass") when the JSON has no elements array', () => {
    for (const bad of [null, undefined, 'text', {}, { remark: 'runtime error' }, { elements: 'x' }]) {
      assert.throws(
        () => parseOverpass(bad),
        (err) => {
          assert.ok(
            err instanceof UpstreamError,
            `input ${JSON.stringify(bad)}: expected UpstreamError, got ${err?.name}`,
          );
          assert.equal(err.service, 'overpass');
          assert.equal(err.code, 'UPSTREAM');
          return true;
        },
      );
    }
  });
});

// ---------------------------------------------------------------------------------------------
// OverpassCameraSource
// ---------------------------------------------------------------------------------------------

describe('OverpassCameraSource', () => {
  test('name is "overpass"', () => {
    assert.equal(new OverpassCameraSource({ fetch: fakeOverpass([]).fetch }).name, 'overpass');
  });

  test('POSTs to the configured endpoint with body "data=<urlencoded query>" and the User-Agent header', async () => {
    const server = fakeOverpass([alprNode(1, 33.75, -84.35)]);
    const src = new OverpassCameraSource({
      endpoint: 'https://overpass.test/api/interpreter',
      fetch: server.fetch,
      userAgent: 'acceptance-tests/1.0',
    });
    await src.getCameras(ONE_TILE_BBOX);

    assert.ok(server.calls.length >= 1, 'no request was made');
    for (const call of server.calls) {
      assert.equal(call.url, 'https://overpass.test/api/interpreter');
      assert.equal(String(call.init.method).toUpperCase(), 'POST');
      assert.match(call.body, /^data=/, 'body does not start with "data="');
      assert.doesNotMatch(call.body.slice(5), /[\s"[\];]/, 'query in body is not urlencoded');
      assert.ok(call.query.startsWith('[out:json]'), `decoded query is not Overpass QL: ${call.query}`);
      assert.match(call.query, /surveillance:type/);
      assert.equal(new Headers(call.init.headers).get('user-agent'), 'acceptance-tests/1.0');
    }
  });

  test('defaults to OVERPASS_ENDPOINT and USER_AGENT', async () => {
    const server = fakeOverpass([]);
    await new OverpassCameraSource({ fetch: server.fetch }).getCameras(ONE_TILE_BBOX);
    assert.ok(server.calls.length >= 1, 'no request was made');
    for (const call of server.calls) {
      assert.equal(call.url, OVERPASS_ENDPOINT);
      assert.equal(new Headers(call.init.headers).get('user-agent'), USER_AGENT);
    }
  });

  test('returns parsed cameras inside the bbox, edges inclusive, and drops cameras outside it', async () => {
    const server = fakeOverpass([
      alprNode(1, 33.75, -84.35, { manufacturer: 'Flock Safety' }), // inside
      alprNode(2, 33.72, -84.36), // on the south edge
      alprNode(3, 33.76, -84.32), // on the east edge
      alprNode(4, 33.78, -84.38), // north-west corner
      alprNode(5, 33.79, -84.35), // same tile, north of the bbox
      alprNode(6, 33.75, -84.31), // same tile, east of the bbox
    ]);
    const cams = await new OverpassCameraSource({ fetch: server.fetch }).getCameras(ONE_TILE_BBOX);

    assert.deepEqual(sortedIds(cams), ['osm:node/1', 'osm:node/2', 'osm:node/3', 'osm:node/4']);
    const flock = cams.find((c) => c.id === 'osm:node/1');
    assert.deepEqual(cameraFields(flock), {
      id: 'osm:node/1',
      lat: 33.75,
      lon: -84.35,
      isFlock: true,
      manufacturer: 'Flock Safety',
      operator: null,
      direction: null,
      source: 'osm',
    });
  });

  test('returns [] for an area with no cameras', async () => {
    const server = fakeOverpass([]);
    assert.deepEqual(await new OverpassCameraSource({ fetch: server.fetch }).getCameras(ONE_TILE_BBOX), []);
  });

  test('a bbox spanning several tiles returns cameras from every tile, each id once', async () => {
    // Spans lat tiles 33.6/33.7/33.8 and lon tiles -84.5/-84.4/-84.3 (3 x 3).
    const bbox = { south: 33.65, west: -84.45, north: 33.85, east: -84.25 };
    const server = fakeOverpass([
      alprNode(1, 33.66, -84.44), // south-west tile
      alprNode(2, 33.75, -84.35), // middle tile
      alprNode(3, 33.84, -84.26), // north-east tile
      alprNode(4, 33.8, -84.38), // on a lat tile boundary: both neighbours return it
      alprNode(5, 33.75, -84.3), // on a lon tile boundary: both neighbours return it
      alprNode(6, 33.62, -84.35), // in a spanned tile but south of the bbox
      alprNode(7, 33.95, -84.35), // outside every spanned tile
    ]);
    const cams = await new OverpassCameraSource({ fetch: server.fetch }).getCameras(bbox);
    assert.deepEqual(sortedIds(cams), [
      'osm:node/1',
      'osm:node/2',
      'osm:node/3',
      'osm:node/4',
      'osm:node/5',
    ]);
  });

  test('dedupes by id when Overpass returns the same camera for several tiles', async () => {
    // A server that ignores the bbox and always returns the same nodes.
    const nodes = [alprNode(1, 33.75, -84.35), alprNode(2, 33.85, -84.25), alprNode(3, 34.5, -85.5)];
    const fetch = async () => jsonResponse({ elements: nodes });
    const bbox = { south: 33.72, west: -84.38, north: 33.88, east: -84.22 }; // 2 x 2 tiles
    const cams = await new OverpassCameraSource({ fetch }).getCameras(bbox);
    assert.deepEqual(sortedIds(cams), ['osm:node/1', 'osm:node/2']);
  });

  test('queries Overpass for whole tiles aligned to the 0.1-degree grid', async () => {
    const server = fakeOverpass([]);
    await new OverpassCameraSource({ fetch: server.fetch }).getCameras({
      south: 33.72,
      west: -84.38,
      north: 33.85,
      east: -84.25,
    });
    assert.ok(server.calls.length >= 1, 'no request was made');
    const onGrid = (v) => Math.abs(v / TILE_DEG - Math.round(v / TILE_DEG)) < 1e-4;
    for (const { bbox } of server.calls) {
      for (const k of ['south', 'west', 'north', 'east']) {
        assert.ok(onGrid(bbox[k]), `queried ${k}=${bbox[k]} is not a multiple of ${TILE_DEG}`);
      }
      assert.ok(bbox.north > bbox.south && bbox.east > bbox.west, 'queried an empty bbox');
    }
  });

  test('a second call for the same area within ttlMs makes no request', async () => {
    const clock = fakeClock();
    const server = fakeOverpass([alprNode(1, 33.75, -84.35)]);
    const src = new OverpassCameraSource({ fetch: server.fetch, now: clock.now, ttlMs: 60_000 });

    const first = await src.getCameras(ONE_TILE_BBOX);
    const callsAfterFirst = server.calls.length;
    assert.ok(callsAfterFirst >= 1, 'first call made no request');

    clock.t += 59_000;
    const second = await src.getCameras(ONE_TILE_BBOX);
    assert.equal(server.calls.length, callsAfterFirst, 'second call within ttlMs made a request');
    assert.deepEqual(sortedIds(second), sortedIds(first));
  });

  test('a smaller bbox inside already-cached tiles makes no request and is still filtered to the bbox', async () => {
    const clock = fakeClock();
    const server = fakeOverpass([alprNode(1, 33.75, -84.35), alprNode(2, 33.72, -84.38)]);
    const src = new OverpassCameraSource({ fetch: server.fetch, now: clock.now });

    await src.getCameras({ south: 33.71, west: -84.39, north: 33.79, east: -84.31 });
    const callsAfterFirst = server.calls.length;

    clock.t += 1_000;
    const cams = await src.getCameras({ south: 33.74, west: -84.36, north: 33.76, east: -84.34 });
    assert.equal(server.calls.length, callsAfterFirst, 'cached tile was requested again');
    assert.deepEqual(ids(cams), ['osm:node/1']);
  });

  test('when a bbox grows into new tiles, only the missing tiles are fetched', async () => {
    const clock = fakeClock();
    const server = fakeOverpass([alprNode(1, 33.75, -84.35), alprNode(2, 33.75, -84.25)]);
    const src = new OverpassCameraSource({ fetch: server.fetch, now: clock.now });

    // Tile lon -84.4..-84.3 only.
    await src.getCameras(ONE_TILE_BBOX);
    const callsAfterFirst = server.calls.length;

    // Same tile plus the one to the east (lon -84.3..-84.2).
    clock.t += 1_000;
    const cams = await src.getCameras({ south: 33.72, west: -84.38, north: 33.78, east: -84.22 });
    const newCalls = server.calls.slice(callsAfterFirst);
    assert.ok(newCalls.length >= 1, 'the new tile was not fetched');
    for (const { bbox } of newCalls) {
      assert.ok(
        bbox.west >= -84.3 - 1e-4,
        `refetched the cached tile: queried west=${bbox.west}, expected >= -84.3`,
      );
    }
    assert.deepEqual(sortedIds(cams), ['osm:node/1', 'osm:node/2']);
  });

  test('a tile is fetched again once ttlMs has passed', async () => {
    const clock = fakeClock();
    const nodes = [alprNode(1, 33.75, -84.35)];
    const server = fakeOverpass(nodes);
    const src = new OverpassCameraSource({ fetch: server.fetch, now: clock.now, ttlMs: 60_000 });

    await src.getCameras(ONE_TILE_BBOX);
    const callsAfterFirst = server.calls.length;

    nodes.push(alprNode(2, 33.76, -84.36)); // newly mapped camera
    clock.t += 61_000;
    const cams = await src.getCameras(ONE_TILE_BBOX);
    assert.ok(server.calls.length > callsAfterFirst, 'expired tile was not refetched');
    assert.deepEqual(sortedIds(cams), ['osm:node/1', 'osm:node/2']);
  });

  test('default cache lifetime is CAMERA_CACHE_TTL_MS, 6 hours', async () => {
    assert.equal(CAMERA_CACHE_TTL_MS, 6 * 60 * 60 * 1000);
    const clock = fakeClock();
    const server = fakeOverpass([alprNode(1, 33.75, -84.35)]);
    const src = new OverpassCameraSource({ fetch: server.fetch, now: clock.now });

    await src.getCameras(ONE_TILE_BBOX);
    const callsAfterFirst = server.calls.length;

    clock.t += CAMERA_CACHE_TTL_MS - 60_000; // 5 h 59 min
    await src.getCameras(ONE_TILE_BBOX);
    assert.equal(server.calls.length, callsAfterFirst, 'refetched before 6 hours');

    clock.t += 120_000; // 6 h 1 min
    await src.getCameras(ONE_TILE_BBOX);
    assert.ok(server.calls.length > callsAfterFirst, 'did not refetch after 6 hours');
  });

  test('rejects with UpstreamError("overpass") on network failure', async () => {
    const fetch = async () => {
      throw new TypeError('fetch failed');
    };
    await assertOverpassUpstreamError(new OverpassCameraSource({ fetch }).getCameras(ONE_TILE_BBOX));
  });

  test('rejects with UpstreamError("overpass") on a non-2xx response', async () => {
    for (const status of [400, 429, 500, 504]) {
      const fetch = async () => new Response('rate limited or broken', { status });
      await assertOverpassUpstreamError(new OverpassCameraSource({ fetch }).getCameras(ONE_TILE_BBOX));
    }
  });

  test('rejects with UpstreamError("overpass") on a response that is not JSON', async () => {
    const fetch = async () =>
      new Response('<html><body>Overpass is busy</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    await assertOverpassUpstreamError(new OverpassCameraSource({ fetch }).getCameras(ONE_TILE_BBOX));
  });

  test('rejects with UpstreamError("overpass") on JSON without an elements array', async () => {
    const fetch = async () => jsonResponse({ remark: 'runtime error: query timed out' });
    await assertOverpassUpstreamError(new OverpassCameraSource({ fetch }).getCameras(ONE_TILE_BBOX));
  });

  test('a failed tile is not cached: the next call fetches it again', async () => {
    const clock = fakeClock();
    const server = fakeOverpass([alprNode(1, 33.75, -84.35)]);
    let failNext = true;
    let attempts = 0;
    const fetch = async (url, init) => {
      attempts += 1;
      if (failNext) return new Response('busy', { status: 503 });
      return server.fetch(url, init);
    };
    const src = new OverpassCameraSource({ fetch, now: clock.now });

    await assertOverpassUpstreamError(src.getCameras(ONE_TILE_BBOX));
    const attemptsAfterFailure = attempts;

    failNext = false;
    clock.t += 1_000;
    const cams = await src.getCameras(ONE_TILE_BBOX);
    assert.ok(attempts > attemptsAfterFailure, 'failed tile was served from cache');
    assert.deepEqual(ids(cams), ['osm:node/1']);
  });
});

// ---------------------------------------------------------------------------------------------
// data/sample-cameras.json (written by the cameras module)
// ---------------------------------------------------------------------------------------------

describe('sample file data/sample-cameras.json', () => {
  test('is {note, cameras} with a note saying the cameras are made up', () => {
    const file = readSampleFile();
    assert.equal(typeof file.note, 'string');
    assert.match(file.note, /made[- ]up|not real/i);
    assert.ok(Array.isArray(file.cameras), 'cameras is not an array');
  });

  test('has 20 to 40 cameras', () => {
    const n = readSampleFile().cameras.length;
    assert.ok(n >= 20 && n <= 40, `has ${n} cameras`);
  });

  test('every camera has the Camera shape with id "sample:<n>" and source "sample"', () => {
    for (const c of readSampleFile().cameras) {
      const where = JSON.stringify(c);
      assert.match(String(c.id), /^sample:\d+$/, `bad id: ${where}`);
      assert.equal(typeof c.id, 'string', `id not a string: ${where}`);
      assert.ok(Number.isFinite(c.lat) && Number.isFinite(c.lon), `lat/lon not numbers: ${where}`);
      assert.equal(typeof c.isFlock, 'boolean', `isFlock not boolean: ${where}`);
      assert.ok(c.manufacturer === null || typeof c.manufacturer === 'string', `manufacturer: ${where}`);
      assert.ok(c.operator === null || typeof c.operator === 'string', `operator: ${where}`);
      assert.ok(
        c.direction === null || (Number.isFinite(c.direction) && c.direction >= 0 && c.direction < 360),
        `direction not null or 0-359 degrees: ${where}`,
      );
      assert.equal(c.source, 'sample', `source: ${where}`);
    }
  });

  test('camera ids are unique', () => {
    const all = ids(readSampleFile().cameras);
    assert.equal(new Set(all).size, all.length, 'duplicate ids');
  });

  test('every camera is in San Luis Obispo (lat 35.24-35.31, lon -120.69 to -120.62)', () => {
    for (const c of readSampleFile().cameras) {
      assert.ok(c.lat >= 35.24 && c.lat <= 35.31, `${c.id} lat ${c.lat} out of range`);
      assert.ok(c.lon >= -120.69 && c.lon <= -120.62, `${c.id} lon ${c.lon} out of range`);
    }
  });

  test('about a third of the cameras are Flock (between 20% and 50%)', () => {
    const cams = readSampleFile().cameras;
    const share = cams.filter((c) => c.isFlock === true).length / cams.length;
    assert.ok(share >= 0.2 && share <= 0.5, `Flock share is ${(share * 100).toFixed(0)}%`);
  });

  test('cameras whose manufacturer contains "flock" are marked isFlock', () => {
    for (const c of readSampleFile().cameras) {
      if (typeof c.manufacturer === 'string' && /flock/i.test(c.manufacturer)) {
        assert.equal(c.isFlock, true, `${c.id} has manufacturer ${c.manufacturer} but isFlock false`);
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------
// loadSampleCameras
// ---------------------------------------------------------------------------------------------

describe('loadSampleCameras', () => {
  test('with no argument, synchronously returns the cameras in data/sample-cameras.json', () => {
    const cams = loadSampleCameras();
    assert.ok(Array.isArray(cams), 'did not return an array synchronously');
    assert.deepEqual(cams.map(cameraFields), readSampleFile().cameras.map(cameraFields));
  });

  test('reads the file given as a path string or a URL', () => {
    const url = new URL('sample-valid.json', FIXTURES);
    for (const path of [fileURLToPath(url), url]) {
      const cams = loadSampleCameras(path);
      assert.deepEqual(ids(cams), ['sample:1', 'sample:2']);
      assert.deepEqual(cameraFields(cams[0]), {
        id: 'sample:1',
        lat: 33.7537,
        lon: -84.3901,
        isFlock: true,
        manufacturer: 'Flock Safety',
        operator: 'Test PD',
        direction: 90,
        source: 'sample',
      });
    }
  });

  test('throws InputError when the file has no cameras array', () => {
    assertInputError(() => loadSampleCameras(new URL('sample-no-cameras.json', FIXTURES)));
    assertInputError(() => loadSampleCameras(new URL('sample-cameras-not-array.json', FIXTURES)));
  });

  test('throws InputError when any camera lacks a string id', () => {
    assertInputError(() => loadSampleCameras(new URL('sample-numeric-id.json', FIXTURES)));
    assertInputError(() => loadSampleCameras(new URL('sample-missing-id.json', FIXTURES)));
  });

  test('throws InputError when any camera lacks a numeric lat or lon', () => {
    assertInputError(() => loadSampleCameras(new URL('sample-string-lat.json', FIXTURES)));
    assertInputError(() => loadSampleCameras(new URL('sample-missing-lon.json', FIXTURES)));
  });
});

// ---------------------------------------------------------------------------------------------
// FixtureCameraSource
// ---------------------------------------------------------------------------------------------

describe('FixtureCameraSource', () => {
  /** @param {string} id @param {number} lat @param {number} lon */
  const cam = (id, lat, lon) => ({
    id,
    lat,
    lon,
    isFlock: false,
    manufacturer: null,
    operator: null,
    direction: null,
    source: 'sample',
  });

  test('name is "fixture"', () => {
    assert.equal(new FixtureCameraSource({ cameras: [] }).name, 'fixture');
  });

  test('returns the injected cameras inside the bbox, edges inclusive, in their original order', async () => {
    const cameras = [
      cam('sample:1', 33.75, -84.39), // inside
      cam('sample:2', 33.7, -84.4), // on the south edge
      cam('sample:3', 33.75, -84.46), // west of the bbox
      cam('sample:4', 33.8, -84.35), // north-east corner
      cam('sample:5', 33.8001, -84.39), // just north of the bbox
      cam('sample:6', 33.71, -84.45), // on the west edge
    ];
    const bbox = { south: 33.7, west: -84.45, north: 33.8, east: -84.35 };
    const got = await new FixtureCameraSource({ cameras }).getCameras(bbox);
    assert.deepEqual(ids(got), ['sample:1', 'sample:2', 'sample:4', 'sample:6']);
    assert.deepEqual(cameraFields(got[0]), cameras[0]);
  });

  test('resolves to [] (does not reject) for a bbox with no cameras', async () => {
    const src = new FixtureCameraSource({ cameras: [cam('sample:1', 33.75, -84.39)] });
    assert.deepEqual(await src.getCameras({ south: 40, west: -75, north: 40.1, east: -74.9 }), []);
  });

  test('without injected cameras, serves the sample file cameras (loadSampleCameras())', async () => {
    const got = await new FixtureCameraSource().getCameras({
      south: 35.2,
      west: -120.75,
      north: 35.35,
      east: -120.6,
    });
    assert.deepEqual(ids(got), ids(readSampleFile().cameras));
  });
});
