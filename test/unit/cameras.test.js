// Unit tests for the cameras module: src/cameras/overpass.js and src/cameras/fixture.js.
// No network: Overpass is a fake `fetch` that answers from an in-memory list of nodes.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  OVERPASS_ENDPOINT,
  TILE_DEG,
  buildOverpassQuery,
  parseOverpass,
  OverpassCameraSource,
} from '../../src/cameras/overpass.js';
import { SAMPLE_CAMERAS_PATH, loadSampleCameras, FixtureCameraSource } from '../../src/cameras/fixture.js';
import { CAMERA_CACHE_TTL_MS, USER_AGENT, InputError, UpstreamError } from '../../src/types.js';

const FIXTURES = new URL('../fixtures/cameras/', import.meta.url);
const fixture = (name) => new URL(name, FIXTURES);
const readJson = (name) => JSON.parse(readFileSync(fixture(name), 'utf8'));

/** One 0.1-degree tile in central Atlanta: lat 33.7-33.8, lon -84.4 to -84.3. */
const TILE = { south: 33.7, west: -84.4, north: 33.8, east: -84.3 };
/** A bbox well inside TILE. */
const INSIDE_TILE = { south: 33.74, west: -84.39, north: 33.76, east: -84.37 };

/** An Overpass node as the API returns it. */
function node(id, lat, lon, tags = {}) {
  return { type: 'node', id, lat, lon, tags: { man_made: 'surveillance', 'surveillance:type': 'ALPR', ...tags } };
}

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

/** Pull the bbox out of an Overpass QL query built by buildOverpassQuery. */
function bboxOfQuery(query) {
  const m = query.match(/\((-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\)/);
  assert.ok(m, `no bbox in query: ${query}`);
  const [south, west, north, east] = m.slice(1).map(Number);
  return { south, west, north, east };
}

/**
 * A fake Overpass server. Answers each POST with the nodes inside the query's bbox and records
 * every call. `delayMs` holds responses back so tests can overlap calls.
 */
function fakeOverpass(nodes, { delayMs = 0 } = {}) {
  const calls = [];
  async function fetch(url, init = {}) {
    const body = String(init.body ?? '');
    assert.ok(body.startsWith('data='), `body should be data=<query>, got ${body.slice(0, 40)}`);
    const query = decodeURIComponent(body.slice('data='.length).replace(/\+/g, ' '));
    const bbox = bboxOfQuery(query);
    calls.push({ url: String(url), init, query, bbox });
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const elements = nodes.filter(
      (n) => n.lat >= bbox.south && n.lat <= bbox.north && n.lon >= bbox.west && n.lon <= bbox.east,
    );
    return jsonResponse({ version: 0.6, elements });
  }
  return { fetch, calls };
}

function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

async function assertUpstream(promise, pattern) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof UpstreamError, `expected UpstreamError, got ${err?.name}: ${err?.message}`);
    assert.equal(err.code, 'UPSTREAM');
    assert.equal(err.service, 'overpass');
    assert.match(err.message, /^overpass: /);
    if (pattern) assert.match(err.message, pattern);
    return true;
  });
}

const sortIds = (cams) => cams.map((c) => c.id).sort();

// ---------------------------------------------------------------------------------------------

describe('constants', () => {
  test('endpoint and tile size', () => {
    assert.equal(OVERPASS_ENDPOINT, 'https://overpass-api.de/api/interpreter');
    assert.equal(TILE_DEG, 0.1);
  });
});

describe('buildOverpassQuery', () => {
  test('has the required parts in order', () => {
    const q = buildOverpassQuery({ south: 33.7, west: -84.4, north: 33.8, east: -84.3 });
    assert.ok(q.startsWith('[out:json]'), q);
    assert.match(q, /\[timeout:\d+\]/);
    assert.ok(q.trimEnd().endsWith('out body;'), q);
    assert.ok(q.includes('node["surveillance:type"="ALPR"](33.7,-84.4,33.8,-84.3);'), q);
  });

  test('bbox is in Overpass order south,west,north,east', () => {
    const q = buildOverpassQuery({ north: 2, east: 4, south: 1, west: 3 });
    assert.deepEqual(bboxOfQuery(q), { south: 1, west: 3, north: 2, east: 4 });
  });

  test('rejects an invalid bbox with InputError', () => {
    for (const bad of [
      null,
      {},
      { south: 1, west: 2, north: 0, east: 3 }, // south > north
      { south: 0, west: 3, north: 1, east: 2 }, // west > east
      { south: NaN, west: 0, north: 1, east: 1 },
      { south: '1', west: 0, north: 2, east: 1 },
      { south: -91, west: 0, north: 1, east: 1 },
      { south: 0, west: 0, north: 1, east: 181 },
    ]) {
      assert.throws(() => buildOverpassQuery(bad), InputError, JSON.stringify(bad));
    }
  });
});

describe('parseOverpass', () => {
  const cams = parseOverpass(readJson('unit-overpass-response.json'));

  test('keeps only ALPR nodes with numeric lat/lon', () => {
    assert.deepEqual(
      cams.map((c) => c.id),
      ['osm:node/1001', 'osm:node/1002', 'osm:node/1003'],
    );
  });

  test('builds full Camera objects', () => {
    assert.deepEqual(cams[0], {
      id: 'osm:node/1001',
      lat: 33.7816,
      lon: -84.3838,
      isFlock: true,
      manufacturer: 'Flock Safety',
      operator: 'Example Police',
      direction: 90,
      source: 'osm',
    });
  });

  test('isFlock from brand too, case-insensitive; camera:direction cardinal', () => {
    assert.equal(cams[1].isFlock, true);
    assert.equal(cams[1].manufacturer, null);
    assert.equal(cams[1].operator, null);
    assert.equal(cams[1].direction, 45);
  });

  test('non-Flock manufacturer and unparseable direction', () => {
    assert.equal(cams[2].isFlock, false);
    assert.equal(cams[2].manufacturer, 'Other Vendor');
    assert.equal(cams[2].direction, null);
  });

  test('direction parsing', () => {
    const dir = (tags) => parseOverpass({ elements: [node(1, 0, 0, tags)] })[0].direction;
    assert.equal(dir({ direction: '90;270' }), 90);
    assert.equal(dir({ direction: ' 135 ' }), 135);
    assert.equal(dir({ direction: '12.5' }), 12.5);
    assert.equal(dir({ direction: '45-135' }), 45);
    assert.equal(dir({ direction: 'NE' }), 45);
    assert.equal(dir({ direction: 'sw' }), 225);
    assert.equal(dir({ direction: 'NNW' }), 337.5);
    assert.equal(dir({ direction: 'W;N' }), 270);
    assert.equal(dir({ direction: '360' }), 0);
    assert.equal(dir({ direction: '-90' }), 270);
    assert.equal(dir({ direction: 'forward' }), null);
    assert.equal(dir({ direction: '' }), null);
    assert.equal(dir({}), null);
    assert.equal(dir({ direction: 'junk', 'camera:direction': '200' }), 200);
    assert.equal(dir({ direction: '10', 'camera:direction': '200' }), 10);
  });

  test('isFlock rules', () => {
    const flock = (tags) => parseOverpass({ elements: [node(1, 0, 0, tags)] })[0].isFlock;
    assert.equal(flock({ manufacturer: 'Flock Safety' }), true);
    assert.equal(flock({ manufacturer: 'flock safety' }), true);
    assert.equal(flock({ brand: 'Flock' }), true);
    assert.equal(flock({ manufacturer: 'Motorola Solutions' }), false);
    assert.equal(flock({ operator: 'Flock Safety' }), false); // operator does not count
    assert.equal(flock({}), false);
  });

  test('whitespace-only tags become null', () => {
    const [c] = parseOverpass({ elements: [node(7, 1, 2, { manufacturer: '  ', operator: ' Town ' })] });
    assert.equal(c.manufacturer, null);
    assert.equal(c.operator, 'Town');
  });

  test('skips elements without tags, with a bad id, or of other types', () => {
    const out = parseOverpass({
      elements: [
        { type: 'node', id: 1, lat: 1, lon: 1 },
        { type: 'node', lat: 1, lon: 1, tags: { 'surveillance:type': 'ALPR' } },
        { type: 'node', id: -5, lat: 1, lon: 1, tags: { 'surveillance:type': 'ALPR' } },
        { type: 'relation', id: 3, tags: { 'surveillance:type': 'ALPR' } },
        null,
        'junk',
        node(4, 1, 1, { 'surveillance:type': 'alpr' }), // tag value must match exactly
        node(5, Infinity, 1),
        node(6, 1, 1),
      ],
    });
    assert.deepEqual(out.map((c) => c.id), ['osm:node/6']);
  });

  test('empty elements gives no cameras', () => {
    assert.deepEqual(parseOverpass({ elements: [] }), []);
  });

  test('no elements array throws UpstreamError', () => {
    for (const bad of [null, undefined, 'x', 42, {}, { elements: 'x' }, { elements: {} }]) {
      assert.throws(
        () => parseOverpass(bad),
        (err) => err instanceof UpstreamError && err.code === 'UPSTREAM' && err.service === 'overpass',
        JSON.stringify(bad),
      );
    }
  });
});

describe('OverpassCameraSource', () => {
  const NODES = [
    node(1, 33.75, -84.38, { manufacturer: 'Flock Safety' }),
    node(2, 33.71, -84.31),
    node(3, 33.85, -84.38), // next tile north
    node(4, 33.75, -84.25), // next tile east
    node(5, 33.8, -84.35), // exactly on the grid line between two tiles
  ];

  test('defaults', () => {
    const src = new OverpassCameraSource({ fetch: async () => jsonResponse({ elements: [] }) });
    assert.equal(src.name, 'overpass');
    assert.equal(src.endpoint, OVERPASS_ENDPOINT);
    assert.equal(src.ttlMs, CAMERA_CACHE_TTL_MS);
    assert.equal(src.userAgent, USER_AGENT);
    assert.equal(typeof src.getCameras, 'function');
  });

  test('POSTs data=<query> to the endpoint with the User-Agent', async () => {
    const server = fakeOverpass(NODES);
    const src = new OverpassCameraSource({ fetch: server.fetch, endpoint: 'https://example.test/api', userAgent: 'ua-test/1' });
    await src.getCameras(INSIDE_TILE);
    assert.equal(server.calls.length, 1);
    const [call] = server.calls;
    assert.equal(call.url, 'https://example.test/api');
    assert.equal(call.init.method, 'POST');
    const headers = new Headers(call.init.headers);
    assert.equal(headers.get('user-agent'), 'ua-test/1');
    assert.match(headers.get('content-type'), /application\/x-www-form-urlencoded/);
    assert.ok(call.query.startsWith('[out:json]'));
    assert.ok(call.query.includes('"surveillance:type"="ALPR"'));
  });

  test('queries the whole aligned tile, then filters to the bbox', async () => {
    const server = fakeOverpass(NODES);
    const src = new OverpassCameraSource({ fetch: server.fetch });
    const cams = await src.getCameras(INSIDE_TILE);
    assert.deepEqual(server.calls[0].bbox, TILE);
    assert.deepEqual(cams.map((c) => c.id), ['osm:node/1']);
    assert.equal(cams[0].isFlock, true);
    assert.equal(cams[0].source, 'osm');
  });

  test('handles floating-point grid edges (33.8 / 0.1 is 337.99...)', async () => {
    const server = fakeOverpass(NODES);
    const src = new OverpassCameraSource({ fetch: server.fetch });
    const cams = await src.getCameras(TILE);
    assert.equal(server.calls.length, 1);
    assert.deepEqual(server.calls[0].bbox, TILE, 'an exact tile is one tile, not four');
    assert.deepEqual(sortIds(cams), ['osm:node/1', 'osm:node/2', 'osm:node/5']);
  });

  test('a zero-size bbox on a grid corner still works', async () => {
    const server = fakeOverpass(NODES);
    const cams = await new OverpassCameraSource({ fetch: server.fetch }).getCameras({
      south: 33.8, west: -84.35, north: 33.8, east: -84.35,
    });
    assert.deepEqual(cams.map((c) => c.id), ['osm:node/5']);
  });

  test('several tiles are fetched in one request and deduped by id', async () => {
    const server = fakeOverpass(NODES);
    const src = new OverpassCameraSource({ fetch: server.fetch });
    const cams = await src.getCameras({ south: 33.72, west: -84.39, north: 33.88, east: -84.22 });
    assert.equal(server.calls.length, 1);
    assert.deepEqual(server.calls[0].bbox, { south: 33.7, west: -84.4, north: 33.9, east: -84.2 });
    // node 5 sits on a tile edge, so it is in two tiles but returned once
    assert.deepEqual(sortIds(cams), ['osm:node/1', 'osm:node/3', 'osm:node/4', 'osm:node/5']);
  });

  test('a second call within ttlMs makes no request', async () => {
    const server = fakeOverpass(NODES);
    const clock = fakeClock();
    const src = new OverpassCameraSource({ fetch: server.fetch, now: clock.now, ttlMs: 60_000 });
    const first = await src.getCameras(INSIDE_TILE);
    clock.advance(59_999);
    const second = await src.getCameras(INSIDE_TILE);
    assert.equal(server.calls.length, 1);
    assert.deepEqual(second, first);
    // a different bbox inside the same cached tile is also served from cache
    const other = await src.getCameras({ south: 33.7, west: -84.32, north: 33.72, east: -84.3 });
    assert.equal(server.calls.length, 1);
    assert.deepEqual(other.map((c) => c.id), ['osm:node/2']);
  });

  test('the tile is fetched again once ttlMs has passed', async () => {
    const server = fakeOverpass(NODES);
    const clock = fakeClock();
    const src = new OverpassCameraSource({ fetch: server.fetch, now: clock.now, ttlMs: 60_000 });
    await src.getCameras(INSIDE_TILE);
    clock.advance(60_000);
    await src.getCameras(INSIDE_TILE);
    assert.equal(server.calls.length, 2);
  });

  test('default TTL is 6 hours', async () => {
    const server = fakeOverpass(NODES);
    const clock = fakeClock();
    const src = new OverpassCameraSource({ fetch: server.fetch, now: clock.now });
    await src.getCameras(INSIDE_TILE);
    clock.advance(6 * 3600_000 - 1);
    await src.getCameras(INSIDE_TILE);
    assert.equal(server.calls.length, 1);
    clock.advance(1);
    await src.getCameras(INSIDE_TILE);
    assert.equal(server.calls.length, 2);
  });

  test('only missing tiles are fetched when a bbox grows', async () => {
    const server = fakeOverpass(NODES);
    const src = new OverpassCameraSource({ fetch: server.fetch, now: fakeClock().now });
    await src.getCameras(INSIDE_TILE);
    const cams = await src.getCameras({ south: 33.74, west: -84.39, north: 33.76, east: -84.25 });
    assert.equal(server.calls.length, 2);
    assert.deepEqual(server.calls[1].bbox, { south: 33.7, west: -84.3, north: 33.8, east: -84.2 });
    assert.deepEqual(sortIds(cams), ['osm:node/1', 'osm:node/4']);
  });

  test('overlapping calls share one in-flight request', async () => {
    const server = fakeOverpass(NODES, { delayMs: 20 });
    const src = new OverpassCameraSource({ fetch: server.fetch });
    const [a, b] = await Promise.all([src.getCameras(INSIDE_TILE), src.getCameras(TILE)]);
    assert.equal(server.calls.length, 1);
    assert.deepEqual(a.map((c) => c.id), ['osm:node/1']);
    assert.deepEqual(sortIds(b), ['osm:node/1', 'osm:node/2', 'osm:node/5']);
  });

  test('returned cameras are copies; changing them does not change the cache', async () => {
    const server = fakeOverpass(NODES);
    const src = new OverpassCameraSource({ fetch: server.fetch });
    const [cam] = await src.getCameras(INSIDE_TILE);
    cam.lat = 0;
    cam.isFlock = false;
    const [again] = await src.getCameras(INSIDE_TILE);
    assert.equal(again.lat, 33.75);
    assert.equal(again.isFlock, true);
  });

  test('accepts a minimal fetch response object (ok + json)', async () => {
    const fetch = async () => ({ ok: true, status: 200, json: async () => ({ elements: [node(9, 33.75, -84.38)] }) });
    const cams = await new OverpassCameraSource({ fetch }).getCameras(INSIDE_TILE);
    assert.deepEqual(cams.map((c) => c.id), ['osm:node/9']);
  });

  describe('failures reject with UpstreamError("overpass", ...)', () => {
    test('network error', async () => {
      const fetch = async () => {
        throw new TypeError('fetch failed');
      };
      await assertUpstream(new OverpassCameraSource({ fetch }).getCameras(INSIDE_TILE), /fetch failed/);
    });

    test('fetch throwing synchronously', async () => {
      const fetch = () => {
        throw new Error('boom');
      };
      await assertUpstream(new OverpassCameraSource({ fetch }).getCameras(INSIDE_TILE), /boom/);
    });

    test('timeout', async () => {
      const fetch = async () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      };
      await assertUpstream(new OverpassCameraSource({ fetch }).getCameras(INSIDE_TILE), /timed out/);
    });

    for (const status of [400, 429, 500, 504]) {
      test(`HTTP ${status}`, async () => {
        const fetch = async () => new Response('busy', { status });
        await assertUpstream(new OverpassCameraSource({ fetch }).getCameras(INSIDE_TILE), new RegExp(String(status)));
      });
    }

    test('429 says rate limited', async () => {
      const fetch = async () => new Response('slow down', { status: 429, statusText: 'Too Many Requests' });
      await assertUpstream(new OverpassCameraSource({ fetch }).getCameras(INSIDE_TILE), /rate limited/);
    });

    test('bad JSON', async () => {
      const fetch = async () => new Response('<html>error</html>', { status: 200 });
      await assertUpstream(new OverpassCameraSource({ fetch }).getCameras(INSIDE_TILE), /JSON/);
    });

    test('JSON without elements', async () => {
      const fetch = async () => jsonResponse({ hello: 'world' });
      await assertUpstream(new OverpassCameraSource({ fetch }).getCameras(INSIDE_TILE), /elements/);
    });

    test('Overpass runtime error remark (HTTP 200)', async () => {
      const fetch = async () =>
        jsonResponse({ elements: [node(1, 33.75, -84.38)], remark: 'runtime error: Query timed out in "query" at line 2 after 25 seconds.' });
      await assertUpstream(new OverpassCameraSource({ fetch }).getCameras(INSIDE_TILE), /runtime error/);
    });

    test('a failed tile is not cached', async () => {
      const server = fakeOverpass(NODES);
      let fail = true;
      const fetch = async (url, init) => {
        if (fail) return new Response('down', { status: 503 });
        return server.fetch(url, init);
      };
      const src = new OverpassCameraSource({ fetch, now: fakeClock().now });
      await assertUpstream(src.getCameras(INSIDE_TILE));
      fail = false;
      const cams = await src.getCameras(INSIDE_TILE);
      assert.deepEqual(cams.map((c) => c.id), ['osm:node/1']);
      assert.equal(server.calls.length, 1);
    });

    test('callers sharing a failed in-flight request all reject, and the tile is retried later', async () => {
      let n = 0;
      const fetch = async () => {
        n += 1;
        await new Promise((r) => setTimeout(r, 10));
        if (n === 1) return new Response('down', { status: 502 });
        return jsonResponse({ elements: [node(1, 33.75, -84.38)] });
      };
      const src = new OverpassCameraSource({ fetch });
      const results = await Promise.allSettled([src.getCameras(INSIDE_TILE), src.getCameras(INSIDE_TILE)]);
      assert.deepEqual(results.map((r) => r.status), ['rejected', 'rejected']);
      assert.equal(n, 1);
      assert.equal((await src.getCameras(INSIDE_TILE)).length, 1);
      assert.equal(n, 2);
    });
  });

  test('invalid bbox rejects with InputError and makes no request', async () => {
    const server = fakeOverpass(NODES);
    const src = new OverpassCameraSource({ fetch: server.fetch });
    await assert.rejects(src.getCameras({ south: 34, west: -84.4, north: 33, east: -84.3 }), InputError);
    await assert.rejects(src.getCameras(undefined), InputError);
    assert.equal(server.calls.length, 0);
  });

  test('a bbox more than 3 degrees across rejects with InputError', async () => {
    const server = fakeOverpass(NODES);
    const src = new OverpassCameraSource({ fetch: server.fetch });
    await assert.rejects(src.getCameras({ south: 30, west: -85, north: 34, east: -84 }), InputError);
    assert.equal(server.calls.length, 0);
    // 3 degrees exactly is fine
    await src.getCameras({ south: 31, west: -85, north: 34, east: -84 });
    assert.equal(server.calls.length, 1);
  });

  test('queries are clamped to valid coordinates at the edges of the world', async () => {
    const server = fakeOverpass([]);
    await new OverpassCameraSource({ fetch: server.fetch }).getCameras({ south: 90, west: 180, north: 90, east: 180 });
    const { bbox } = server.calls[0];
    assert.ok(bbox.north <= 90 && bbox.east <= 180, JSON.stringify(bbox));
  });
});

// ---------------------------------------------------------------------------------------------

describe('loadSampleCameras and data/sample-cameras.json', () => {
  test('the bundled sample file follows the schema', () => {
    const raw = JSON.parse(readFileSync(SAMPLE_CAMERAS_PATH, 'utf8'));
    assert.equal(typeof raw.note, 'string');
    assert.match(raw.note, /made-up/i);
    assert.match(raw.note, /not real/i);

    const cams = loadSampleCameras();
    assert.ok(cams.length >= 20 && cams.length <= 40, `has ${cams.length} cameras`);
    assert.deepEqual(cams, raw.cameras, 'the file already has every field filled in');
    assert.equal(new Set(cams.map((c) => c.id)).size, cams.length, 'ids are unique');
    cams.forEach((c, i) => {
      assert.equal(c.id, `sample:${i + 1}`);
      assert.equal(c.source, 'sample');
      assert.ok(c.lat >= 35.24 && c.lat <= 35.31, `${c.id} lat ${c.lat}`);
      assert.ok(c.lon >= -120.69 && c.lon <= -120.62, `${c.id} lon ${c.lon}`);
      assert.equal(typeof c.isFlock, 'boolean');
      assert.equal(c.isFlock, /flock/i.test(c.manufacturer ?? ''), `${c.id} isFlock matches manufacturer`);
      assert.ok(c.direction === null || (c.direction >= 0 && c.direction < 360));
    });
    const flockShare = cams.filter((c) => c.isFlock).length / cams.length;
    assert.ok(flockShare > 0.25 && flockShare < 0.42, `Flock share ${flockShare}`);
    const coords = new Set(cams.map((c) => `${c.lat},${c.lon}`));
    assert.equal(coords.size, cams.length, 'no two cameras at the same spot');
  });

  test('accepts a path string as well as a URL', () => {
    const fromUrl = loadSampleCameras(fixture('unit-sample-minimal.json'));
    const fromString = loadSampleCameras(fileURLToPath(fixture('unit-sample-minimal.json')));
    assert.deepEqual(fromString, fromUrl);
  });

  test('fills in optional fields', () => {
    const cams = loadSampleCameras(fixture('unit-sample-minimal.json'));
    assert.deepEqual(cams, [
      { id: 'sample:1', lat: 33.75, lon: -84.38, isFlock: false, manufacturer: null, operator: null, direction: null, source: 'sample' },
      { id: 'sample:2', lat: 33.76, lon: -84.39, isFlock: true, manufacturer: 'Flock Safety', operator: null, direction: 45, source: 'sample' },
      { id: 'sample:3', lat: 33.77, lon: -84.4, isFlock: false, manufacturer: 'Flock Safety', operator: null, direction: null, source: 'sample' },
    ]);
  });

  for (const [name, why] of [
    ['unit-sample-no-cameras.json', /cameras/],
    ['unit-sample-no-id.json', /id/],
    ['unit-sample-bad-lat.json', /lat/],
    ['unit-sample-bad-json.json', /JSON/],
    ['does-not-exist.json', /cannot read/],
  ]) {
    test(`throws InputError for ${name}`, () => {
      assert.throws(() => loadSampleCameras(fixture(name)), (err) => {
        assert.ok(err instanceof InputError, `got ${err?.name}`);
        assert.equal(err.code, 'INPUT');
        assert.match(err.message, why);
        return true;
      });
    });
  }
});

describe('FixtureCameraSource', () => {
  const CAMS = [
    { id: 'sample:1', lat: 33.75, lon: -84.38, isFlock: true, manufacturer: 'Flock Safety', operator: null, direction: null, source: 'sample' },
    { id: 'sample:2', lat: 33.7, lon: -84.4, isFlock: false, manufacturer: null, operator: null, direction: 90, source: 'sample' },
    { id: 'sample:3', lat: 33.9, lon: -84.38, isFlock: false, manufacturer: null, operator: null, direction: null, source: 'sample' },
    { id: 'sample:4', lat: 33.72, lon: -84.31, isFlock: false, manufacturer: null, operator: null, direction: null, source: 'sample' },
  ];

  test('name is "fixture"', () => {
    assert.equal(new FixtureCameraSource({ cameras: [] }).name, 'fixture');
  });

  test('cameras inside the bbox, edges inclusive, in file order', async () => {
    const src = new FixtureCameraSource({ cameras: CAMS });
    const cams = await src.getCameras(TILE);
    assert.deepEqual(cams.map((c) => c.id), ['sample:1', 'sample:2', 'sample:4']);
    assert.deepEqual(cams[0], CAMS[0]);
  });

  test('empty result for a bbox with no cameras', async () => {
    const src = new FixtureCameraSource({ cameras: CAMS });
    assert.deepEqual(await src.getCameras({ south: 10, west: 10, north: 11, east: 11 }), []);
  });

  test('dedupes by id (first wins) and returns copies', async () => {
    const src = new FixtureCameraSource({ cameras: [CAMS[0], { ...CAMS[0], lat: 33.76 }] });
    const cams = await src.getCameras(TILE);
    assert.equal(cams.length, 1);
    assert.equal(cams[0].lat, 33.75);
    cams[0].lat = 0;
    assert.equal(CAMS[0].lat, 33.75);
  });

  test('defaults to the bundled sample file', async () => {
    const src = new FixtureCameraSource();
    const all = await src.getCameras({ south: 35.2, west: -120.75, north: 35.35, east: -120.6 });
    assert.deepEqual(all, loadSampleCameras());
    const downtown = await src.getCameras({ south: 35.275, west: -120.668, north: 35.282, east: -120.658 });
    assert.ok(downtown.length >= 1 && downtown.length < all.length);
  });

  test('invalid bbox rejects with InputError', async () => {
    const src = new FixtureCameraSource({ cameras: CAMS });
    await assert.rejects(src.getCameras({ south: 1, west: 0, north: 0, east: 1 }), InputError);
    await assert.rejects(src.getCameras(null), InputError);
  });
});
