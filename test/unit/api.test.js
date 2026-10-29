// Unit tests for the api module: src/server/app.js and src/server/main.js.
// No outside network: servers listen on 127.0.0.1 port 0, sources/routers/planRoutes are fakes.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  APP_TITLE,
  APP_VERSION,
  DEFAULT_BUFFER_M,
  DEFAULT_CENTER,
  DEFAULT_ZOOM,
  InputError,
  MAX_BBOX_SPAN_DEG,
  MAX_BUFFER_M,
  MAX_TRIP_M,
  MIN_BUFFER_M,
  MIN_CAMERA_ZOOM,
  NoRouteError,
  NotImplementedError,
  TripTooLongError,
  UpstreamError,
  USER_AGENT,
} from '../../src/types.js';
import { createServer, errorStatus, parseBbox, DEFAULT_PUBLIC_DIR, MAX_BODY_BYTES } from '../../src/server/app.js';
import { configFromEnv } from '../../src/server/main.js';
import { OverpassCameraSource } from '../../src/cameras/overpass.js';
import { FixtureCameraSource } from '../../src/cameras/fixture.js';
import { ValhallaRouter } from '../../src/routing/valhalla.js';
import { StubRouter } from '../../src/routing/stub.js';

const MAIN_PATH = fileURLToPath(new URL('../../src/server/main.js', import.meta.url));
const JSON_TYPE = 'application/json; charset=utf-8';

// ---------- helpers ----------

const SAMPLE_CAMERA = {
  id: 'sample:1',
  lat: 33.75,
  lon: -84.39,
  isFlock: true,
  manufacturer: 'Flock Safety',
  operator: null,
  direction: null,
  source: 'sample',
};

function fakeSource(impl) {
  const calls = [];
  return {
    name: 'fake-source',
    calls,
    getCameras(bbox) {
      calls.push(bbox);
      return impl ? impl(bbox) : Promise.resolve([SAMPLE_CAMERA]);
    },
  };
}

function fakeRouter() {
  return {
    name: 'fake-router',
    maxAvoid: 5,
    async route() {
      throw new Error('fake router should not be called by the api module');
    },
  };
}

const SAMPLE_PLAN = {
  fastest: { route: { points: [[33.7, -84.4], [33.8, -84.3]], distanceM: 1000, durationS: 90 }, cameraIds: ['sample:1'] },
  avoiding: { route: { points: [[33.7, -84.4], [33.75, -84.2], [33.8, -84.3]], distanceM: 1500, durationS: 135 }, cameraIds: [] },
  cameras: [SAMPLE_CAMERA],
  bufferM: 75,
  iterations: 1,
  notes: [],
};

function fakePlanner(impl) {
  const calls = [];
  const fn = async (req, deps) => {
    calls.push({ req, deps });
    return impl ? impl(req, deps) : SAMPLE_PLAN;
  };
  fn.calls = calls;
  return fn;
}

async function start(deps) {
  const server = createServer(deps);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    server,
    port,
    base: `http://127.0.0.1:${port}`,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Raw HTTP request so tests control the exact path and body framing. */
function raw(port, { method = 'GET', path: reqPath = '/', headers = {}, body, chunks } = {}) {
  return new Promise((resolve, reject) => {
    let gotResponse = false;
    const req = http.request({ host: '127.0.0.1', port, method, path: reqPath, headers, agent: false }, (res) => {
      gotResponse = true;
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, text });
      });
      res.on('error', reject);
    });
    req.on('error', (err) => {
      if (!gotResponse) reject(err);
    });
    if (chunks) {
      for (const c of chunks) req.write(c);
      req.end();
    } else {
      req.end(body);
    }
  });
}

async function getJson(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

function postRoute(base, body) {
  return getJson(`${base}/api/route`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const VALID_PLAN_REQUEST = { start: { lat: 33.75, lon: -84.39 }, end: { lat: 33.77, lon: -84.36 }, bufferM: 75 };

// ---------- parseBbox ----------

describe('parseBbox', () => {
  test('parses four decimal numbers in south,west,north,east order', () => {
    assert.deepEqual(parseBbox('33.7,-84.4,33.8,-84.3'), { south: 33.7, west: -84.4, north: 33.8, east: -84.3 });
  });

  test('allows spaces around numbers, signs and exponents', () => {
    assert.deepEqual(parseBbox(' 33.7 , -84.4,+33.8, -8.43e1 '), { south: 33.7, west: -84.4, north: 33.8, east: -84.3 });
  });

  test('accepts a zero-size box and a box of exactly MAX_BBOX_SPAN_DEG, despite float rounding', () => {
    assert.deepEqual(parseBbox('33.7,-84.4,33.7,-84.4'), { south: 33.7, west: -84.4, north: 33.7, east: -84.4 });
    // 33.7 - 33.2 is 0.5000000000000036 in floating point.
    const b = parseBbox(`33.2,-84.7,33.7,-84.2`);
    assert.equal(b.north, 33.7);
    assert.equal(MAX_BBOX_SPAN_DEG, 0.5);
  });

  for (const [label, text] of [
    ['undefined', undefined],
    ['null', null],
    ['empty', ''],
    ['blank', '   '],
    ['three numbers', '33.7,-84.4,33.8'],
    ['five numbers', '33.7,-84.4,33.8,-84.3,1'],
    ['an empty part', '33.7,,33.8,-84.3'],
    ['a word', '33.7,west,33.8,-84.3'],
    ['NaN', '33.7,NaN,33.8,-84.3'],
    ['Infinity', '33.7,-84.4,Infinity,-84.3'],
    ['hex', '0x21,-84.4,33.8,-84.3'],
    ['trailing junk', '33.7,-84.4,33.8,-84.3abc'],
    ['south > north', '33.8,-84.4,33.7,-84.3'],
    ['west > east', '33.7,-84.3,33.8,-84.4'],
    ['latitude out of range', '89.9,-84.4,90.1,-84.3'],
    ['longitude out of range', '33.7,-180.1,33.8,-179.9'],
    ['too tall', '33.0,-84.4,33.6,-84.3'],
    ['too wide', '33.7,-84.9,33.8,-84.3'],
    ['just over the span', '33.0,-84.4,33.5000001,-84.3'],
  ]) {
    test(`throws InputError for ${label}`, () => {
      assert.throws(() => parseBbox(text), (err) => err instanceof InputError && err.code === 'INPUT');
    });
  }
});

// ---------- errorStatus ----------

describe('errorStatus', () => {
  test('maps the shared error classes', () => {
    assert.equal(errorStatus(new InputError('x')), 400);
    assert.equal(errorStatus(new TripTooLongError('x')), 422);
    assert.equal(errorStatus(new NoRouteError('x')), 422);
    assert.equal(errorStatus(new UpstreamError('overpass', 'x')), 502);
  });

  test('anything else is 500', () => {
    assert.equal(errorStatus(new Error('x')), 500);
    assert.equal(errorStatus(new TypeError('x')), 500);
    assert.equal(errorStatus(new NotImplementedError('x')), 500);
    assert.equal(errorStatus('a string'), 500);
    assert.equal(errorStatus(null), 500);
    assert.equal(errorStatus(undefined), 500);
    assert.equal(errorStatus({ code: 'INPUT' }), 500);
  });
});

// ---------- HTTP API ----------

describe('createServer API routes', () => {
  let srv;
  let source;
  let router;
  let planner;
  let behavior; // per-test override for the fake planner

  before(async () => {
    source = fakeSource();
    router = fakeRouter();
    planner = fakePlanner((req, deps) => (behavior ? behavior(req, deps) : SAMPLE_PLAN));
    srv = await start({ cameraSource: source, router, planRoutes: planner, publicDir: os.tmpdir() });
  });

  after(async () => {
    await srv.close();
  });

  test('createServer returns an http.Server that is not listening yet', () => {
    const s = createServer({ cameraSource: source, router, planRoutes: planner });
    assert.ok(s instanceof http.Server);
    assert.equal(s.listening, false);
  });

  test('GET /api/health', async () => {
    const { status, headers, body } = await getJson(`${srv.base}/api/health`);
    assert.equal(status, 200);
    assert.equal(headers.get('content-type'), JSON_TYPE);
    assert.deepEqual(body, { ok: true, cameraSource: 'fake-source', router: 'fake-router' });
  });

  test('GET /api/config returns ClientConfig from the shared constants', async () => {
    const { status, headers, body } = await getJson(`${srv.base}/api/config`);
    assert.equal(status, 200);
    assert.equal(headers.get('content-type'), JSON_TYPE);
    assert.deepEqual(body, {
      center: { lat: DEFAULT_CENTER.lat, lon: DEFAULT_CENTER.lon },
      zoom: DEFAULT_ZOOM,
      minCameraZoom: MIN_CAMERA_ZOOM,
      defaultBufferM: DEFAULT_BUFFER_M,
      minBufferM: MIN_BUFFER_M,
      maxBufferM: MAX_BUFFER_M,
      maxTripM: MAX_TRIP_M,
      maxBboxSpanDeg: MAX_BBOX_SPAN_DEG,
      cameraSource: 'fake-source',
      router: 'fake-router',
      geocoder: 'coordinates',
      appTitle: APP_TITLE,
      version: APP_VERSION,
    });
  });

  test('GET /api/cameras passes the parsed bbox to the source', async () => {
    source.calls.length = 0;
    const { status, headers, body } = await getJson(`${srv.base}/api/cameras?bbox=33.7,-84.4,33.8,-84.3`);
    assert.equal(status, 200);
    assert.equal(headers.get('content-type'), JSON_TYPE);
    assert.deepEqual(body, { cameras: [SAMPLE_CAMERA], source: 'fake-source' });
    assert.deepEqual(source.calls, [{ south: 33.7, west: -84.4, north: 33.8, east: -84.3 }]);
  });

  test('GET /api/cameras with a URL-encoded bbox', async () => {
    const { status } = await getJson(`${srv.base}/api/cameras?bbox=${encodeURIComponent('33.7, -84.4, 33.8, -84.3')}`);
    assert.equal(status, 200);
  });

  for (const [label, query] of [
    ['missing', ''],
    ['empty', '?bbox='],
    ['malformed', '?bbox=1,2,3'],
    ['south > north', '?bbox=33.8,-84.4,33.7,-84.3'],
    ['west > east', '?bbox=33.7,-84.3,33.8,-84.4'],
    ['too large', '?bbox=33.0,-85.0,34.0,-84.0'],
  ]) {
    test(`GET /api/cameras is 400 when bbox is ${label}, and the source is not called`, async () => {
      source.calls.length = 0;
      const { status, headers, body } = await getJson(`${srv.base}/api/cameras${query}`);
      assert.equal(status, 400);
      assert.equal(headers.get('content-type'), JSON_TYPE);
      assert.equal(body.code, 'INPUT');
      assert.equal(typeof body.error, 'string');
      assert.ok(body.error.length > 0);
      assert.equal(source.calls.length, 0);
    });
  }

  test('POST /api/route passes the parsed body and {cameraSource, router} to planRoutes', async () => {
    planner.calls.length = 0;
    behavior = null;
    const { status, headers, body } = await postRoute(srv.base, VALID_PLAN_REQUEST);
    assert.equal(status, 200);
    assert.equal(headers.get('content-type'), JSON_TYPE);
    assert.deepEqual(body, SAMPLE_PLAN);
    assert.equal(planner.calls.length, 1);
    assert.deepEqual(planner.calls[0].req, VALID_PLAN_REQUEST);
    assert.equal(planner.calls[0].deps.cameraSource, source);
    assert.equal(planner.calls[0].deps.router, router);
  });

  test('POST /api/route works without a Content-Type header', async () => {
    behavior = null;
    const res = await raw(srv.port, { method: 'POST', path: '/api/route', body: JSON.stringify(VALID_PLAN_REQUEST) });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.text), SAMPLE_PLAN);
  });

  for (const [label, body] of [
    ['invalid JSON', '{"start": '],
    ['an empty body', ''],
    ['a JSON array', '[1, 2]'],
    ['JSON null', 'null'],
    ['a JSON string', '"hello"'],
  ]) {
    test(`POST /api/route is 400 INPUT for ${label}, without calling planRoutes`, async () => {
      planner.calls.length = 0;
      const res = await postRoute(srv.base, body);
      assert.equal(res.status, 400);
      assert.equal(res.headers.get('content-type'), JSON_TYPE);
      assert.equal(res.body.code, 'INPUT');
      assert.equal(typeof res.body.error, 'string');
      assert.equal(planner.calls.length, 0);
    });
  }

  for (const [label, makeErr, status, code] of [
    ['InputError', () => new InputError('start is missing'), 400, 'INPUT'],
    ['TripTooLongError', () => new TripTooLongError('trip is 61 km; the limit is 50 km'), 422, 'TRIP_TOO_LONG'],
    ['NoRouteError', () => new NoRouteError('no path'), 422, 'NO_ROUTE'],
    ['UpstreamError', () => new UpstreamError('valhalla', 'HTTP 503'), 502, 'UPSTREAM'],
  ]) {
    test(`POST /api/route maps ${label} to ${status} {error, code: ${code}}`, async (t) => {
      t.mock.method(console, 'warn', () => {});
      t.mock.method(console, 'error', () => {});
      const err = makeErr();
      behavior = () => {
        throw err;
      };
      const res = await postRoute(srv.base, VALID_PLAN_REQUEST);
      behavior = null;
      assert.equal(res.status, status);
      assert.equal(res.headers.get('content-type'), JSON_TYPE);
      assert.deepEqual(res.body, { error: err.message, code });
    });
  }

  test('POST /api/route: an unexpected error is 500 INTERNAL, logged, and the server keeps serving', async (t) => {
    const logged = t.mock.method(console, 'error', () => {});
    behavior = () => {
      const e = new Error('boom');
      e.code = 'ENOENT'; // a non-API code must not leak through as the response code
      throw e;
    };
    const res = await postRoute(srv.base, VALID_PLAN_REQUEST);
    behavior = null;
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: 'boom', code: 'INTERNAL' });
    assert.ok(logged.mock.callCount() >= 1);
    const health = await getJson(`${srv.base}/api/health`);
    assert.equal(health.status, 200);
  });

  test('POST /api/route: a thrown non-Error is 500 with a generic message', async (t) => {
    t.mock.method(console, 'error', () => {});
    behavior = () => {
      throw 'just a string'; // eslint-disable-line no-throw-literal
    };
    const res = await postRoute(srv.base, VALID_PLAN_REQUEST);
    behavior = null;
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: 'Internal server error', code: 'INTERNAL' });
  });

  test('POST /api/route accepts a body of exactly MAX_BODY_BYTES', async () => {
    behavior = null;
    planner.calls.length = 0;
    const base = JSON.stringify({ ...VALID_PLAN_REQUEST, pad: '' });
    const padded = JSON.stringify({ ...VALID_PLAN_REQUEST, pad: 'x'.repeat(MAX_BODY_BYTES - Buffer.byteLength(base)) });
    assert.equal(Buffer.byteLength(padded), MAX_BODY_BYTES);
    const res = await postRoute(srv.base, padded);
    assert.equal(res.status, 200);
    assert.equal(planner.calls.length, 1);
  });

  test('POST /api/route is 413 when Content-Length is over the limit', async () => {
    planner.calls.length = 0;
    const res = await postRoute(srv.base, 'x'.repeat(MAX_BODY_BYTES + 1));
    assert.equal(res.status, 413);
    assert.equal(res.headers.get('content-type'), JSON_TYPE);
    assert.equal(res.body.code, 'BODY_TOO_LARGE');
    assert.equal(typeof res.body.error, 'string');
    assert.equal(planner.calls.length, 0);
  });

  test('POST /api/route is 413 for a chunked body that grows past the limit', async () => {
    planner.calls.length = 0;
    const chunk = 'x'.repeat(4096);
    const res = await raw(srv.port, {
      method: 'POST',
      path: '/api/route',
      headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' },
      chunks: [chunk, chunk, chunk, chunk],
    });
    assert.equal(res.status, 413);
    assert.equal(JSON.parse(res.text).code, 'BODY_TOO_LARGE');
    assert.equal(planner.calls.length, 0);
    const health = await getJson(`${srv.base}/api/health`);
    assert.equal(health.status, 200);
  });

  test('MAX_BODY_BYTES is 10 kB', () => {
    assert.equal(MAX_BODY_BYTES, 10_000);
  });

  test('wrong method on an API route is 405 JSON with an Allow header', async () => {
    const get = await getJson(`${srv.base}/api/route`);
    assert.equal(get.status, 405);
    assert.equal(get.headers.get('allow'), 'POST');
    assert.equal(get.headers.get('content-type'), JSON_TYPE);
    assert.equal(get.body.code, 'METHOD_NOT_ALLOWED');

    const post = await getJson(`${srv.base}/api/health`, { method: 'POST', body: '{}' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('allow'), 'GET, HEAD');
    assert.equal(typeof post.body.error, 'string');

    const del = await getJson(`${srv.base}/api/cameras?bbox=33.7,-84.4,33.8,-84.3`, { method: 'DELETE' });
    assert.equal(del.status, 405);
  });

  for (const p of ['/api/nope', '/api', '/api/', '/api/health/', '/api/cameras/extra']) {
    test(`unknown API path ${p} is 404 JSON`, async () => {
      for (const method of ['GET', 'POST']) {
        const res = await getJson(`${srv.base}${p}`, { method, body: method === 'POST' ? '{}' : undefined });
        assert.equal(res.status, 404);
        assert.equal(res.headers.get('content-type'), JSON_TYPE);
        assert.equal(res.body.code, 'NOT_FOUND');
        assert.equal(typeof res.body.error, 'string');
      }
    });
  }

  test('a path starting with // is a path, not a host', async () => {
    const api = await raw(srv.port, { path: '//api/health' });
    assert.equal(api.status, 404);
    assert.equal(JSON.parse(api.text).code, 'NOT_FOUND');
    const health = await raw(srv.port, { path: '/api/health' });
    assert.equal(health.status, 200);
  });

  test('HEAD /api/health is 200 with no body', async () => {
    const res = await raw(srv.port, { method: 'HEAD', path: '/api/health' });
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], JSON_TYPE);
    assert.equal(res.text, '');
  });

  test('API responses are not cached', async () => {
    const { headers } = await getJson(`${srv.base}/api/config`);
    assert.equal(headers.get('cache-control'), 'no-store');
  });
});

describe('createServer camera source failures', () => {
  test('UpstreamError from the source is 502 UPSTREAM', async (t) => {
    t.mock.method(console, 'warn', () => {});
    const source = fakeSource(() => Promise.reject(new UpstreamError('overpass', 'HTTP 504')));
    const srv = await start({ cameraSource: source, router: fakeRouter(), planRoutes: fakePlanner() });
    try {
      const res = await getJson(`${srv.base}/api/cameras?bbox=33.7,-84.4,33.8,-84.3`);
      assert.equal(res.status, 502);
      assert.deepEqual(res.body, { error: 'overpass: HTTP 504', code: 'UPSTREAM' });
    } finally {
      await srv.close();
    }
  });

  test('a source that throws synchronously is 500 and does not crash the server', async (t) => {
    t.mock.method(console, 'error', () => {});
    const source = fakeSource(() => {
      throw new TypeError('kaboom');
    });
    const srv = await start({ cameraSource: source, router: fakeRouter(), planRoutes: fakePlanner() });
    try {
      const res = await getJson(`${srv.base}/api/cameras?bbox=33.7,-84.4,33.8,-84.3`);
      assert.equal(res.status, 500);
      assert.equal(res.body.code, 'INTERNAL');
      const again = await getJson(`${srv.base}/api/health`);
      assert.equal(again.status, 200);
    } finally {
      await srv.close();
    }
  });
});

// ---------- static files ----------

describe('createServer static files', () => {
  let tmp;
  let pub;
  let srv;

  before(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'alpr-api-test-'));
    pub = path.join(tmp, 'public');
    await mkdir(path.join(pub, 'sub'), { recursive: true });
    await mkdir(path.join(pub, 'emptydir'));
    await mkdir(path.join(pub, '.git'));
    await writeFile(path.join(pub, 'index.html'), '<!doctype html><title>Home</title>');
    await writeFile(path.join(pub, 'app.js'), 'console.log("app");');
    await writeFile(path.join(pub, 'style.css'), 'body { color: black; }');
    await writeFile(path.join(pub, 'data.json'), '{"a":1}');
    await writeFile(path.join(pub, 'blob.xyz'), 'binary-ish');
    await writeFile(path.join(pub, 'with space.txt'), 'spaced');
    await writeFile(path.join(pub, '.env'), 'SECRET=1');
    await writeFile(path.join(pub, '.git', 'config'), 'gitconfig');
    await writeFile(path.join(pub, 'sub', 'index.html'), '<p>sub</p>');
    await writeFile(path.join(pub, 'sub', 'note.txt'), 'note');
    await writeFile(path.join(tmp, 'secret.txt'), 'TOP SECRET');
    await writeFile(path.join(tmp, 'public-other.txt'), 'SIBLING');
    await symlink(path.join(tmp, 'secret.txt'), path.join(pub, 'escape.txt'));
    await symlink(path.join(pub, 'app.js'), path.join(pub, 'inside-link.js'));
    srv = await start({ cameraSource: fakeSource(), router: fakeRouter(), planRoutes: fakePlanner(), publicDir: pub });
  });

  after(async () => {
    await srv.close();
    await rm(tmp, { recursive: true, force: true });
  });

  for (const [p, type, content] of [
    ['/', 'text/html; charset=utf-8', '<!doctype html><title>Home</title>'],
    ['/index.html', 'text/html; charset=utf-8', '<!doctype html><title>Home</title>'],
    ['/app.js', 'text/javascript; charset=utf-8', 'console.log("app");'],
    ['/style.css', 'text/css; charset=utf-8', 'body { color: black; }'],
    ['/data.json', 'application/json; charset=utf-8', '{"a":1}'],
    ['/blob.xyz', 'application/octet-stream', 'binary-ish'],
    ['/sub/', 'text/html; charset=utf-8', '<p>sub</p>'],
    ['/sub/note.txt', 'text/plain; charset=utf-8', 'note'],
    ['/with%20space.txt', 'text/plain; charset=utf-8', 'spaced'],
    ['/inside-link.js', 'text/javascript; charset=utf-8', 'console.log("app");'],
    ['/app.js?v=3', 'text/javascript; charset=utf-8', 'console.log("app");'],
    ['//sub/note.txt', 'text/plain; charset=utf-8', 'note'],
  ]) {
    test(`GET ${p} serves the file as ${type}`, async () => {
      const res = await raw(srv.port, { path: p });
      assert.equal(res.status, 200);
      assert.equal(res.headers['content-type'], type);
      assert.equal(res.text, content);
    });
  }

  test('a publicDir given as a file URL works too', async () => {
    const s = await start({
      cameraSource: fakeSource(),
      router: fakeRouter(),
      planRoutes: fakePlanner(),
      publicDir: new URL(`file://${pub}/`),
    });
    try {
      const res = await raw(s.port, { path: '/app.js' });
      assert.equal(res.status, 200);
      assert.equal(res.text, 'console.log("app");');
    } finally {
      await s.close();
    }
  });

  for (const p of [
    '/missing.html',
    '/sub/missing.txt',
    '/emptydir',
    '/emptydir/',
    '/sub',
    '/.env',
    '/.git/config',
    '/%2eenv',
    '/escape.txt',
    '/../secret.txt',
    '/sub/../../secret.txt',
    '/%2e%2e/secret.txt',
    '/..%2fsecret.txt',
    '/sub/..%2f..%2fsecret.txt',
    '/%2e%2e%2fsecret.txt',
    '/..%5csecret.txt',
    '/../public-other.txt',
    '/%2e%2e/public-other.txt',
    '/app.js%00.html',
    '/%E0%A4%A',
  ]) {
    test(`GET ${p} is a JSON 404 and leaks nothing`, async () => {
      const res = await raw(srv.port, { path: p });
      assert.equal(res.status, 404);
      assert.equal(res.headers['content-type'], JSON_TYPE);
      assert.ok(!res.text.includes('TOP SECRET'));
      assert.ok(!res.text.includes('SIBLING'));
      assert.ok(!res.text.includes('SECRET=1'));
      const body = JSON.parse(res.text);
      assert.equal(body.code, 'NOT_FOUND');
      assert.equal(typeof body.error, 'string');
    });
  }

  test('HEAD / is 200 with headers and no body', async () => {
    const res = await raw(srv.port, { method: 'HEAD', path: '/' });
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(res.text, '');
  });

  test('POST or DELETE on a static path is 405 JSON', async () => {
    for (const method of ['POST', 'DELETE', 'PUT']) {
      const res = await raw(srv.port, { method, path: '/index.html', body: '' });
      assert.equal(res.status, 405);
      assert.equal(res.headers['content-type'], JSON_TYPE);
      assert.equal(res.headers.allow, 'GET, HEAD');
      assert.equal(JSON.parse(res.text).code, 'METHOD_NOT_ALLOWED');
    }
  });

  test('a missing publicDir gives 404s, not a crash', async () => {
    const s = await start({
      cameraSource: fakeSource(),
      router: fakeRouter(),
      planRoutes: fakePlanner(),
      publicDir: path.join(tmp, 'does-not-exist'),
    });
    try {
      const res = await raw(s.port, { path: '/' });
      assert.equal(res.status, 404);
      const health = await getJson(`${s.base}/api/health`);
      assert.equal(health.status, 200);
    } finally {
      await s.close();
    }
  });

  test('the default publicDir is the project public/ folder', async () => {
    assert.ok(DEFAULT_PUBLIC_DIR instanceof URL);
    assert.ok(fileURLToPath(DEFAULT_PUBLIC_DIR).endsWith(`${path.sep}public${path.sep}`));
    const s = await start({ cameraSource: fakeSource(), router: fakeRouter(), planRoutes: fakePlanner() });
    try {
      const res = await raw(s.port, { path: '/lib.js' });
      assert.equal(res.status, 200);
      assert.equal(res.headers['content-type'], 'text/javascript; charset=utf-8');
    } finally {
      await s.close();
    }
  });
});

// ---------- configFromEnv ----------

describe('configFromEnv', () => {
  test('defaults: Overpass, Valhalla, 127.0.0.1:8080', () => {
    const c = configFromEnv({});
    assert.ok(c.cameraSource instanceof OverpassCameraSource);
    assert.ok(c.router instanceof ValhallaRouter);
    assert.equal(c.cameraSource.name, 'overpass');
    assert.equal(c.router.name, 'valhalla');
    assert.equal(c.host, '127.0.0.1');
    assert.equal(c.port, 8080);
    assert.equal(c.cameraSource.userAgent, USER_AGENT);
    assert.equal(c.router.userAgent, USER_AGENT);
  });

  test('OFFLINE=1 picks the fixture source and stub router', () => {
    const c = configFromEnv({ OFFLINE: '1' });
    assert.ok(c.cameraSource instanceof FixtureCameraSource);
    assert.ok(c.router instanceof StubRouter);
    assert.equal(c.cameraSource.name, 'fixture');
    assert.equal(c.router.name, 'stub');
  });

  test('OFFLINE wins over CAMERA_SOURCE and ROUTER, and its "off" values are respected', () => {
    const on = configFromEnv({ OFFLINE: 'true', CAMERA_SOURCE: 'overpass', ROUTER: 'valhalla' });
    assert.equal(on.cameraSource.name, 'fixture');
    assert.equal(on.router.name, 'stub');
    for (const off of ['0', 'false', 'no', 'off', '', '  ']) {
      const c = configFromEnv({ OFFLINE: off });
      assert.equal(c.cameraSource.name, 'overpass', `OFFLINE=${JSON.stringify(off)}`);
      assert.equal(c.router.name, 'valhalla');
    }
  });

  test('CAMERA_SOURCE and ROUTER can be set separately, case-insensitively', () => {
    const a = configFromEnv({ CAMERA_SOURCE: 'fixture' });
    assert.equal(a.cameraSource.name, 'fixture');
    assert.equal(a.router.name, 'valhalla');
    const b = configFromEnv({ ROUTER: ' Stub ' });
    assert.equal(b.cameraSource.name, 'overpass');
    assert.equal(b.router.name, 'stub');
    const c = configFromEnv({ CAMERA_SOURCE: '', ROUTER: '' });
    assert.equal(c.cameraSource.name, 'overpass');
    assert.equal(c.router.name, 'valhalla');
  });

  test('unknown CAMERA_SOURCE or ROUTER throws InputError naming the variable', () => {
    assert.throws(() => configFromEnv({ CAMERA_SOURCE: 'google' }), (err) => {
      return err instanceof InputError && /CAMERA_SOURCE/.test(err.message) && /google/.test(err.message);
    });
    assert.throws(() => configFromEnv({ ROUTER: 'osrm' }), (err) => {
      return err instanceof InputError && /ROUTER/.test(err.message) && /osrm/.test(err.message);
    });
    assert.throws(() => configFromEnv({ CAMERA_SOURCE: 'constructor' }), InputError);
  });

  test('PORT and HOST', () => {
    assert.equal(configFromEnv({ PORT: '3000' }).port, 3000);
    assert.equal(configFromEnv({ PORT: '0' }).port, 0);
    assert.equal(configFromEnv({ PORT: '' }).port, 8080);
    assert.equal(configFromEnv({ HOST: '0.0.0.0' }).host, '0.0.0.0');
    assert.equal(configFromEnv({ HOST: '' }).host, '127.0.0.1');
    for (const bad of ['abc', '-1', '65536', '80.5', '1e3', '0x50']) {
      assert.throws(() => configFromEnv({ PORT: bad }), InputError, `PORT=${bad}`);
    }
  });

  test('CONTACT goes into the User-Agent of the live source and router', () => {
    const c = configFromEnv({ CONTACT: 'me@example.com' });
    const product = USER_AGENT.slice(0, USER_AGENT.indexOf(' ('));
    assert.equal(c.cameraSource.userAgent, `${product} (me@example.com)`);
    assert.equal(c.router.userAgent, `${product} (me@example.com)`);
    assert.throws(() => configFromEnv({ CONTACT: 'me@example.com\r\nX-Evil: 1' }), InputError);
  });
});

// ---------- main (child process, localhost only) ----------

function runMain(env, { waitFor, timeoutMs = 10_000 } = {}) {
  const child = spawn(process.execPath, [MAIN_PATH], {
    env: { ...process.env, CAMERA_SOURCE: '', ROUTER: '', OFFLINE: '', CONTACT: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  const ready = waitFor
    ? new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out; stdout=${stdout} stderr=${stderr}`)), timeoutMs);
        const check = () => {
          const m = stdout.match(waitFor);
          if (m) {
            clearTimeout(timer);
            resolve(m);
          }
        };
        child.stdout.on('data', check);
        exited.then((code) => {
          clearTimeout(timer);
          reject(new Error(`exited ${code}; stdout=${stdout} stderr=${stderr}`));
        });
      })
    : null;
  return { child, exited, ready, output: () => ({ stdout, stderr }) };
}

describe('main', () => {
  test('OFFLINE=1 starts the server and prints the documented start line', async () => {
    const run = runMain(
      { OFFLINE: '1', PORT: '0', HOST: '127.0.0.1' },
      { waitFor: /^ALPR Route Planner on http:\/\/127\.0\.0\.1:(\d+) \(cameras: fixture, router: stub\)$/m },
    );
    try {
      const m = await run.ready;
      const port = Number(m[1]);
      assert.ok(port > 0);
      const res = await getJson(`http://127.0.0.1:${port}/api/health`);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { ok: true, cameraSource: 'fixture', router: 'stub' });
    } finally {
      run.child.kill();
      await run.exited;
    }
  });

  test('an unknown ROUTER exits with code 1 and a message', async () => {
    const run = runMain({ ROUTER: 'bogus', PORT: '0' });
    const code = await run.exited;
    assert.equal(code, 1);
    assert.match(run.output().stderr, /Unknown ROUTER "bogus"/);
    assert.equal(run.output().stdout, '');
  });

  test('an unknown CAMERA_SOURCE exits with code 1 and a message', async () => {
    const run = runMain({ CAMERA_SOURCE: 'bogus', PORT: '0' });
    assert.equal(await run.exited, 1);
    assert.match(run.output().stderr, /Unknown CAMERA_SOURCE "bogus"/);
  });

  test('a port that is in use exits with code 1 and a message', async () => {
    const blocker = http.createServer();
    await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const { port } = blocker.address();
    try {
      const run = runMain({ OFFLINE: '1', PORT: String(port), HOST: '127.0.0.1' });
      assert.equal(await run.exited, 1);
      assert.match(run.output().stderr, /already in use/);
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });
});
