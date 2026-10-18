// Acceptance tests for the api module (src/server/app.js, src/server/main.js).
// Written from .hub/spec.md and the interface JSDoc only. No network: camera sources,
// routers and planRoutes are fakes; servers listen on 127.0.0.1 port 0; static files come
// from a temp publicDir. Each test name states the promise it checks.
// The few tests that need another module (the real planner, the sample camera file) skip
// themselves while that module still throws NotImplementedError, so a failure here points at api.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseBbox, errorStatus, createServer } from '../../src/server/app.js';
import { configFromEnv } from '../../src/server/main.js';
import { validatePlanRequest } from '../../src/planner.js';
import { loadSampleCameras } from '../../src/cameras/fixture.js';
import {
  APP_TITLE,
  DEFAULT_BUFFER_M,
  MIN_BUFFER_M,
  MAX_BUFFER_M,
  MAX_TRIP_M,
  MAX_BBOX_SPAN_DEG,
  DEFAULT_CENTER,
  DEFAULT_ZOOM,
  MIN_CAMERA_ZOOM,
  InputError,
  TripTooLongError,
  NoRouteError,
  UpstreamError,
  NotImplementedError,
} from '../../src/types.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MAIN_JS = fileURLToPath(new URL('../../src/server/main.js', import.meta.url));
const JSON_TYPE = 'application/json; charset=utf-8';

// ---------------------------------------------------------------- fixtures and fakes

const CAMERAS = [
  {
    id: 'osm:node/101',
    lat: 33.75,
    lon: -84.39,
    isFlock: true,
    manufacturer: 'Flock Safety',
    operator: 'Atlanta Police Department',
    direction: 90,
    source: 'osm',
  },
  {
    id: 'osm:node/102',
    lat: 33.76,
    lon: -84.38,
    isFlock: false,
    manufacturer: null,
    operator: null,
    direction: null,
    source: 'osm',
  },
];

const PLAN = {
  fastest: {
    route: { points: [[33.75, -84.39], [33.77, -84.37]], distanceM: 2900, durationS: 300 },
    cameraIds: ['osm:node/101'],
  },
  avoiding: {
    route: { points: [[33.75, -84.39], [33.76, -84.4], [33.77, -84.37]], distanceM: 3400, durationS: 360 },
    cameraIds: [],
  },
  cameras: CAMERAS,
  bufferM: 75,
  iterations: 1,
  notes: ['1 camera(s) next to your start or end can\'t be avoided.'],
};

const PLAN_BODY = { start: { lat: 33.75, lon: -84.39 }, end: { lat: 33.77, lon: -84.37 }, bufferM: 75 };

/** A CameraSource that records every bbox it is asked for. */
function fakeSource({ name = 'fake-cams', getCameras } = {}) {
  const calls = [];
  const source = {
    name,
    calls,
    getCameras(bbox) {
      calls.push(bbox);
      if (getCameras) return getCameras(bbox);
      return Promise.resolve(CAMERAS);
    },
  };
  return source;
}

/** A Router that records calls. The api itself should never need to call it when planRoutes is injected. */
function fakeRouter({ name = 'fake-router' } = {}) {
  const calls = [];
  return {
    name,
    maxAvoid: 50,
    calls,
    async route(req) {
      calls.push(req);
      return { points: [[req.start.lat, req.start.lon], [req.end.lat, req.end.lon]], distanceM: 1000, durationS: 100 };
    },
  };
}

/** A planRoutes replacement that records its arguments. */
function fakePlanRoutes(impl) {
  const calls = [];
  const fn = async (req, deps) => {
    calls.push({ req, deps });
    return impl ? impl(req, deps) : PLAN;
  };
  fn.calls = calls;
  return fn;
}

// Temp publicDir for static file tests, with secrets placed next to it (outside it).
let TMP_ROOT;
let PUBLIC_DIR;
const SECRET_MARKER = 'TOP-SECRET-OUTSIDE-PUBLIC-DIR';
const FILES = {
  'index.html': '<!doctype html><title>index-marker</title><script type="module" src="app.js"></script>',
  'style.css': 'body { color: rgb(1, 2, 3); } /* css-marker */',
  'app.js': 'export const marker = "js-marker";\n',
  'js/nested.js': 'export const nested = "nested-marker";\n',
};

before(() => {
  TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'api-acceptance-'));
  PUBLIC_DIR = path.join(TMP_ROOT, 'public');
  for (const [rel, content] of Object.entries(FILES)) {
    const full = path.join(PUBLIC_DIR, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  fs.writeFileSync(path.join(TMP_ROOT, 'secret.txt'), SECRET_MARKER);
  // A sibling folder whose name starts with "public": catches naive startsWith(publicDir) checks.
  fs.mkdirSync(path.join(TMP_ROOT, 'public-evil'), { recursive: true });
  fs.writeFileSync(path.join(TMP_ROOT, 'public-evil', 'leak.txt'), SECRET_MARKER);
});

after(() => {
  if (TMP_ROOT) fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------- helpers

/**
 * Start createServer(deps) on 127.0.0.1:0, run fn(port), always close.
 * publicDir defaults to the temp PUBLIC_DIR unless defaultPublicDir is true (then it is left out).
 */
async function withServer(deps, fn, { defaultPublicDir = false } = {}) {
  const server = createServer(defaultPublicDir ? deps : { publicDir: PUBLIC_DIR, ...deps });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  try {
    return await fn(port);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

/**
 * Raw HTTP request (no URL normalization, so "/../x" is sent as written).
 * `body` is sent with a Content-Length; `chunks` (array of strings) is sent chunked, without one.
 * Resolves with {status, headers, text, json}; json is undefined when the body is not JSON.
 */
function request(port, { method = 'GET', path: reqPath = '/', headers = {}, body, chunks: bodyChunks } = {}) {
  return new Promise((resolve, reject) => {
    let gotResponse = false;
    const finalHeaders = { ...headers };
    if (body !== undefined) finalHeaders['Content-Length'] = Buffer.byteLength(body);
    if (bodyChunks) finalHeaders['Transfer-Encoding'] = 'chunked';
    const req = http.request(
      { host: '127.0.0.1', port, method, path: reqPath, headers: finalHeaders, agent: false },
      (res) => {
        gotResponse = true;
        const chunks = [];
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          const text = Buffer.concat(chunks).toString('utf8');
          let json;
          try {
            json = JSON.parse(text);
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        };
        res.on('data', (c) => chunks.push(c));
        res.on('end', finish);
        res.on('close', finish);
        res.on('error', finish);
      },
    );
    req.on('error', (err) => {
      if (!gotResponse) reject(err);
    });
    if (body !== undefined) req.write(body);
    for (const c of bodyChunks ?? []) req.write(c);
    req.end();
  });
}

const postJson = (port, reqPath, value) =>
  request(port, {
    method: 'POST',
    path: reqPath,
    headers: { 'Content-Type': 'application/json' },
    body: typeof value === 'string' ? value : JSON.stringify(value),
  });

/** Assert the documented error body shape {error: <message>, code: <string>}. */
function assertErrorBody(res, label = '') {
  assert.ok(res.json && typeof res.json === 'object', `${label} error body should be JSON, got: ${res.text}`);
  assert.equal(typeof res.json.error, 'string', `${label} error.error should be a string`);
  assert.ok(res.json.error.length > 0, `${label} error.error should not be empty`);
  assert.equal(typeof res.json.code, 'string', `${label} error.code should be a string`);
}

/** Silence console output from logged 500s. */
function muteConsole(t) {
  t.mock.method(console, 'error', () => {});
  t.mock.method(console, 'warn', () => {});
}

/** True when the module behind fn has been built (it no longer throws NotImplementedError). */
function isBuilt(fn) {
  try {
    fn();
    return true;
  } catch (err) {
    return !(err instanceof NotImplementedError);
  }
}
const plannerBuilt = () => isBuilt(() => validatePlanRequest(PLAN_BODY));
const camerasBuilt = () => isBuilt(() => loadSampleCameras());

async function freePort() {
  const srv = net.createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (srv.address());
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

function childEnv(overrides) {
  const env = { ...process.env };
  for (const k of ['PORT', 'HOST', 'CAMERA_SOURCE', 'ROUTER', 'OFFLINE', 'CONTACT', 'NODE_TEST_CONTEXT']) delete env[k];
  return { ...env, ...overrides };
}

/**
 * Run `node src/server/main.js` with env overrides.
 * If onLine is given, it is called with each stdout line; returning true stops waiting (the child is then killed).
 * Resolves {code, signal, stdout, stderr, timedOut, matched}.
 */
function runMain(envOverrides, { onLine, timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [MAIN_JS], { cwd: REPO_ROOT, env: childEnv(envOverrides) });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let matched = null;
    let pending = Promise.resolve();
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      const before = stdout;
      stdout += d.toString();
      if (!onLine || matched) return;
      const lines = stdout.split('\n');
      const complete = lines.slice(before.split('\n').length - 1, -1);
      for (const line of complete) {
        pending = pending.then(async () => {
          if (matched) return;
          if (await onLine(line)) {
            matched = line;
            child.kill('SIGTERM');
          }
        });
      }
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('close', async (code, signal) => {
      clearTimeout(timer);
      await pending.catch(() => {});
      resolve({ code, signal, stdout, stderr, timedOut, matched });
    });
  });
}

/** Run a small ES module snippet in a child node with the given env; returns parsed JSON from its stdout. */
function runSnippet(code, envOverrides) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      cwd: REPO_ROOT,
      env: childEnv(envOverrides),
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (codeNum) => {
      clearTimeout(timer);
      if (codeNum !== 0) return reject(new Error(`snippet exited ${codeNum}: ${stderr}`));
      try {
        resolve(JSON.parse(stdout.trim().split('\n').pop()));
      } catch (err) {
        reject(new Error(`snippet printed non-JSON: ${stdout} ${stderr}`));
      }
    });
  });
}

// ================================================================ parseBbox

describe('parseBbox', () => {
  test('parseBbox: "S,W,N,E" becomes {south, west, north, east} numbers', () => {
    assert.deepEqual(parseBbox('33.7,-84.4,33.8,-84.3'), { south: 33.7, west: -84.4, north: 33.8, east: -84.3 });
  });

  test('parseBbox: a span of exactly MAX_BBOX_SPAN_DEG (0.5) is accepted', () => {
    assert.equal(MAX_BBOX_SPAN_DEG, 0.5);
    assert.deepEqual(parseBbox('33.5,-84.5,34,-84'), { south: 33.5, west: -84.5, north: 34, east: -84 });
  });

  test('parseBbox: a zero-area bbox (south == north, west == east) is accepted', () => {
    assert.deepEqual(parseBbox('33.7,-84.4,33.7,-84.4'), { south: 33.7, west: -84.4, north: 33.7, east: -84.4 });
  });

  /** Assert every text in `cases` makes parseBbox throw InputError with code INPUT. */
  function assertAllRejected(cases) {
    for (const [label, text] of cases) {
      assert.throws(
        () => parseBbox(text),
        (err) => err instanceof InputError && err.code === 'INPUT',
        `parseBbox(${JSON.stringify(text)}) [${label}] should throw InputError`,
      );
    }
  }

  test('parseBbox: anything but exactly four finite numbers throws InputError (code INPUT)', () => {
    assertAllRejected([
      ['null', null],
      ['undefined', undefined],
      ['empty string', ''],
      ['three numbers', '33.7,-84.4,33.8'],
      ['five numbers', '33.7,-84.4,33.8,-84.3,1'],
      ['non-numeric parts', 'a,b,c,d'],
      ['an empty part (must not be read as 0)', '0,0,0.1,'],
      ['NaN', 'NaN,-84.4,33.8,-84.3'],
      ['Infinity', '33.7,-84.4,Infinity,-84.3'],
    ]);
  });

  test('parseBbox: south > north throws InputError (code INPUT)', () => {
    assertAllRejected([['south > north', '33.8,-84.4,33.7,-84.3']]);
  });

  test('parseBbox: west > east throws InputError (code INPUT)', () => {
    assertAllRejected([['west > east', '33.7,-84.3,33.8,-84.4']]);
  });

  test('parseBbox: latitude outside [-90, 90] or longitude outside [-180, 180] throws InputError (code INPUT)', () => {
    assertAllRejected([
      ['latitude above 90', '90.1,0,90.2,0.1'],
      ['latitude below -90', '-90.2,0,-90.1,0.1'],
      ['longitude above 180', '0,180.1,0.1,180.2'],
      ['longitude below -180', '0,-180.2,0.1,-180.1'],
    ]);
  });

  test('parseBbox: a latitude or longitude span over MAX_BBOX_SPAN_DEG throws InputError (code INPUT)', () => {
    assertAllRejected([
      ['latitude span 0.6', '33.0,-84.4,33.6,-84.3'],
      ['longitude span 0.6', '33.7,-85.0,33.8,-84.4'],
    ]);
  });
});

// ================================================================ errorStatus

describe('errorStatus', () => {
  test('errorStatus: InputError -> 400', () => {
    assert.equal(errorStatus(new InputError('bad')), 400);
  });
  test('errorStatus: TripTooLongError -> 422 (even though it is an InputError subclass)', () => {
    assert.equal(errorStatus(new TripTooLongError('too far')), 422);
  });
  test('errorStatus: NoRouteError -> 422', () => {
    assert.equal(errorStatus(new NoRouteError('no path')), 422);
  });
  test('errorStatus: UpstreamError -> 502', () => {
    assert.equal(errorStatus(new UpstreamError('valhalla', 'HTTP 503')), 502);
  });
  test('errorStatus: any other error or thrown value -> 500', () => {
    for (const v of [new Error('boom'), new TypeError('x'), 'a string', null, undefined]) {
      assert.equal(errorStatus(v), 500, `errorStatus(${String(v)}) should be 500`);
    }
  });
});

// ================================================================ createServer basics

describe('createServer', () => {
  test('createServer: returns an http.Server that is not yet listening', () => {
    const server = createServer({ cameraSource: fakeSource(), router: fakeRouter(), planRoutes: fakePlanRoutes(), publicDir: PUBLIC_DIR });
    assert.ok(server instanceof http.Server, 'should be a node:http Server');
    assert.equal(server.listening, false, 'should not be started');
  });

  test('all JSON responses (success and error) use Content-Type "application/json; charset=utf-8"', async () => {
    const source = fakeSource();
    await withServer({ cameraSource: source, router: fakeRouter(), planRoutes: fakePlanRoutes() }, async (port) => {
      const responses = {
        'GET /api/health': await request(port, { path: '/api/health' }),
        'GET /api/config': await request(port, { path: '/api/config' }),
        'GET /api/cameras': await request(port, { path: '/api/cameras?bbox=33.7,-84.4,33.8,-84.3' }),
        'POST /api/route': await postJson(port, '/api/route', PLAN_BODY),
        'GET /api/cameras (400)': await request(port, { path: '/api/cameras' }),
        'GET /api/unknown (404)': await request(port, { path: '/api/unknown' }),
        'GET /api/route (405)': await request(port, { path: '/api/route' }),
      };
      for (const [label, res] of Object.entries(responses)) {
        assert.equal(res.headers['content-type'], JSON_TYPE, `${label} Content-Type`);
      }
    });
  });
});

// ================================================================ GET /api/health and /api/config

describe('GET /api/health', () => {
  test('GET /api/health: 200 {ok: true, cameraSource: <source name>, router: <router name>}', async () => {
    await withServer({ cameraSource: fakeSource({ name: 'src-x' }), router: fakeRouter({ name: 'rt-y' }), planRoutes: fakePlanRoutes() }, async (port) => {
      const res = await request(port, { path: '/api/health' });
      assert.equal(res.status, 200);
      assert.equal(res.json.ok, true);
      assert.equal(res.json.cameraSource, 'src-x');
      assert.equal(res.json.router, 'rt-y');
    });
  });
});

describe('GET /api/config', () => {
  test('GET /api/config: 200 ClientConfig built from the shared constants and active names', async () => {
    await withServer({ cameraSource: fakeSource({ name: 'src-x' }), router: fakeRouter({ name: 'rt-y' }), planRoutes: fakePlanRoutes() }, async (port) => {
      const res = await request(port, { path: '/api/config' });
      assert.equal(res.status, 200);
      const c = res.json;
      assert.deepEqual(c.center, { lat: DEFAULT_CENTER.lat, lon: DEFAULT_CENTER.lon }, 'center');
      assert.equal(c.zoom, DEFAULT_ZOOM, 'zoom');
      assert.equal(c.minCameraZoom, MIN_CAMERA_ZOOM, 'minCameraZoom');
      assert.equal(c.defaultBufferM, DEFAULT_BUFFER_M, 'defaultBufferM');
      assert.equal(c.minBufferM, MIN_BUFFER_M, 'minBufferM');
      assert.equal(c.maxBufferM, MAX_BUFFER_M, 'maxBufferM');
      assert.equal(c.maxTripM, MAX_TRIP_M, 'maxTripM');
      assert.equal(c.maxBboxSpanDeg, MAX_BBOX_SPAN_DEG, 'maxBboxSpanDeg');
      assert.equal(c.cameraSource, 'src-x', 'cameraSource');
      assert.equal(c.router, 'rt-y', 'router');
      assert.equal(c.appTitle, APP_TITLE, 'appTitle');
      assert.equal(c.appTitle, 'ALPR Route Planner', 'appTitle exact string');
    });
  });
});

// ================================================================ GET /api/cameras

describe('GET /api/cameras', () => {
  test('GET /api/cameras: 200 {cameras, source} with the bbox passed to cameraSource.getCameras as a BBox', async () => {
    const source = fakeSource({ name: 'src-x' });
    await withServer({ cameraSource: source, router: fakeRouter(), planRoutes: fakePlanRoutes() }, async (port) => {
      const res = await request(port, { path: '/api/cameras?bbox=33.7,-84.4,33.8,-84.3' });
      assert.equal(res.status, 200, res.text);
      assert.deepEqual(res.json.cameras, CAMERAS);
      assert.equal(res.json.source, 'src-x');
      assert.equal(source.calls.length, 1);
      assert.deepEqual(source.calls[0], { south: 33.7, west: -84.4, north: 33.8, east: -84.3 });
    });
  });

  test('GET /api/cameras: a URL-encoded bbox (commas as %2C, as URLSearchParams sends it) works', async () => {
    const source = fakeSource();
    await withServer({ cameraSource: source, router: fakeRouter(), planRoutes: fakePlanRoutes() }, async (port) => {
      const qs = new URLSearchParams({ bbox: '33.7,-84.4,33.8,-84.3' }).toString();
      assert.match(qs, /%2C/);
      const res = await request(port, { path: `/api/cameras?${qs}` });
      assert.equal(res.status, 200, res.text);
      assert.deepEqual(source.calls[0], { south: 33.7, west: -84.4, north: 33.8, east: -84.3 });
    });
  });

  test('GET /api/cameras: a missing, malformed or too-large bbox -> 400 {error, code: "INPUT"} without calling the source', async () => {
    const badQueries = [
      ['missing bbox', '/api/cameras'],
      ['empty bbox', '/api/cameras?bbox='],
      ['three numbers', '/api/cameras?bbox=1,2,3'],
      ['non-numeric', '/api/cameras?bbox=a,b,c,d'],
      ['south > north', '/api/cameras?bbox=33.8,-84.4,33.7,-84.3'],
      ['west > east', '/api/cameras?bbox=33.7,-84.3,33.8,-84.4'],
      ['span > MAX_BBOX_SPAN_DEG', '/api/cameras?bbox=33.0,-85.0,34.0,-84.0'],
    ];
    const source = fakeSource();
    await withServer({ cameraSource: source, router: fakeRouter(), planRoutes: fakePlanRoutes() }, async (port) => {
      for (const [label, reqPath] of badQueries) {
        const res = await request(port, { path: reqPath });
        assert.equal(res.status, 400, `${label} (${reqPath}): ${res.status} ${res.text}`);
        assertErrorBody(res, label);
        assert.equal(res.json.code, 'INPUT', `${label} code`);
      }
      assert.equal(source.calls.length, 0, 'getCameras should not be called for a bad bbox');
    });
  });

  test('GET /api/cameras: source rejecting with UpstreamError -> 502 {error: message, code: "UPSTREAM"}', async () => {
    const err = new UpstreamError('overpass', 'HTTP 504');
    const source = fakeSource({ getCameras: () => Promise.reject(err) });
    await withServer({ cameraSource: source, router: fakeRouter(), planRoutes: fakePlanRoutes() }, async (port) => {
      const res = await request(port, { path: '/api/cameras?bbox=33.7,-84.4,33.8,-84.3' });
      assert.equal(res.status, 502, res.text);
      assertErrorBody(res);
      assert.equal(res.json.code, 'UPSTREAM');
      assert.equal(res.json.error, err.message);
    });
  });
});

// ================================================================ POST /api/route

describe('POST /api/route', () => {
  test('POST /api/route: 200 with the RoutePlan from planRoutes, called with the body and {cameraSource, router}', async () => {
    const source = fakeSource();
    const router = fakeRouter();
    const planRoutes = fakePlanRoutes();
    await withServer({ cameraSource: source, router, planRoutes }, async (port) => {
      const res = await postJson(port, '/api/route', PLAN_BODY);
      assert.equal(res.status, 200, res.text);
      assert.deepEqual(res.json, PLAN);
      assert.equal(planRoutes.calls.length, 1);
      assert.deepEqual(planRoutes.calls[0].req, PLAN_BODY);
      assert.equal(planRoutes.calls[0].deps.cameraSource, source, 'deps.cameraSource is the injected source');
      assert.equal(planRoutes.calls[0].deps.router, router, 'deps.router is the injected router');
    });
  });

  test('POST /api/route: a body that is not valid JSON -> 400 {error, code: "INPUT"} without calling planRoutes', async () => {
    const planRoutes = fakePlanRoutes();
    await withServer({ cameraSource: fakeSource(), router: fakeRouter(), planRoutes }, async (port) => {
      for (const [label, body] of [['truncated JSON', '{"start": {"lat": 33.7,'], ['empty body', ''], ['not JSON at all', 'start=1&end=2']]) {
        const res = await postJson(port, '/api/route', body);
        assert.equal(res.status, 400, `${label}: ${res.status} ${res.text}`);
        assertErrorBody(res, label);
        assert.equal(res.json.code, 'INPUT', `${label} code`);
      }
      assert.equal(planRoutes.calls.length, 0);
    });
  });

  test('POST /api/route: a body under 10 kB is accepted', async () => {
    const planRoutes = fakePlanRoutes();
    await withServer({ cameraSource: fakeSource(), router: fakeRouter(), planRoutes }, async (port) => {
      const body = JSON.stringify({ ...PLAN_BODY, pad: 'x'.repeat(8500) });
      assert.ok(Buffer.byteLength(body) < 9500);
      const res = await postJson(port, '/api/route', body);
      assert.equal(res.status, 200, res.text);
      assert.equal(planRoutes.calls.length, 1);
    });
  });

  test('POST /api/route: a body over 10 kB -> 413 {error, code} without calling planRoutes (with or without Content-Length)', async () => {
    const planRoutes = fakePlanRoutes();
    await withServer({ cameraSource: fakeSource(), router: fakeRouter(), planRoutes }, async (port) => {
      // Valid JSON, so the only problem is its size.
      const body = JSON.stringify({ ...PLAN_BODY, pad: 'x'.repeat(20_000) });
      const sized = await postJson(port, '/api/route', body);
      assert.equal(sized.status, 413, `with Content-Length: ${sized.status} ${sized.text}`);
      assertErrorBody(sized, 'with Content-Length');

      const pieces = body.match(/[\s\S]{1,2000}/g);
      const chunked = await request(port, {
        method: 'POST',
        path: '/api/route',
        headers: { 'Content-Type': 'application/json' },
        chunks: pieces,
      });
      assert.equal(chunked.status, 413, `chunked, no Content-Length: ${chunked.status} ${chunked.text}`);
      assertErrorBody(chunked, 'chunked');

      assert.equal(planRoutes.calls.length, 0, 'planRoutes should not be called for an oversized body');
      const again = await request(port, { path: '/api/health' });
      assert.equal(again.status, 200, 'server should still answer after a 413');
    });
  });

  const mapped = [
    ['InputError', () => new InputError('start.lat must be a number'), 400, 'INPUT'],
    ['TripTooLongError', () => new TripTooLongError('Start and end are 80 km apart; the limit is 50 km.'), 422, 'TRIP_TOO_LONG'],
    ['NoRouteError', () => new NoRouteError('No route between these points.'), 422, 'NO_ROUTE'],
    ['UpstreamError', () => new UpstreamError('valhalla', 'HTTP 503'), 502, 'UPSTREAM'],
  ];
  for (const [name, make, status, code] of mapped) {
    test(`POST /api/route: planRoutes rejecting with ${name} -> ${status} {error: message, code: "${code}"}`, async () => {
      const err = make();
      const planRoutes = fakePlanRoutes(() => Promise.reject(err));
      await withServer({ cameraSource: fakeSource(), router: fakeRouter(), planRoutes }, async (port) => {
        const res = await postJson(port, '/api/route', PLAN_BODY);
        assert.equal(res.status, status, res.text);
        assertErrorBody(res);
        assert.equal(res.json.code, code);
        assert.equal(res.json.error, err.message);
      });
    });
  }

  test('POST /api/route: without an injected planRoutes it uses the planner (bufferM 5 -> 400 INPUT)', async (t) => {
    if (!plannerBuilt()) {
      t.skip('planner module not built yet (validatePlanRequest throws NotImplementedError)');
      return;
    }
    const router = fakeRouter();
    await withServer({ cameraSource: fakeSource(), router }, async (port) => {
      const res = await postJson(port, '/api/route', { ...PLAN_BODY, bufferM: 5 });
      assert.equal(res.status, 400, res.text);
      assertErrorBody(res);
      assert.equal(res.json.code, 'INPUT');
      assert.equal(router.calls.length, 0, 'router should not be called for an invalid request');
    });
  });
});

// ================================================================ unexpected errors

describe('unexpected errors', () => {
  test('an unexpected handler error (thrown or rejected) -> 500 {error, code: "INTERNAL"} and the server keeps serving', async (t) => {
    muteConsole(t);
    const syncThrower = {
      name: 'sync-thrower',
      getCameras() {
        throw new Error('sync boom');
      },
    };
    const planRoutes = fakePlanRoutes(() => Promise.reject(new Error('kaboom')));
    await withServer({ cameraSource: syncThrower, router: fakeRouter(), planRoutes }, async (port) => {
      const cams = await request(port, { path: '/api/cameras?bbox=33.7,-84.4,33.8,-84.3' });
      assert.equal(cams.status, 500, `getCameras throwing synchronously: ${cams.text}`);
      assertErrorBody(cams, 'GET /api/cameras');
      assert.equal(cams.json.code, 'INTERNAL');

      const route = await postJson(port, '/api/route', PLAN_BODY);
      assert.equal(route.status, 500, `planRoutes rejecting with a plain Error: ${route.text}`);
      assertErrorBody(route, 'POST /api/route');
      assert.equal(route.json.code, 'INTERNAL');

      const again = await request(port, { path: '/api/health' });
      assert.equal(again.status, 200, 'server should still answer after handler errors');
    });
  });
});

// ================================================================ unknown routes and wrong methods

describe('unknown /api routes and wrong methods', () => {
  test('unknown /api/* path -> 404 JSON {error, code}', async () => {
    await withServer({ cameraSource: fakeSource(), router: fakeRouter(), planRoutes: fakePlanRoutes() }, async (port) => {
      for (const reqPath of ['/api/unknown', '/api/', '/api/cameras/extra']) {
        const res = await request(port, { path: reqPath });
        assert.equal(res.status, 404, `${reqPath}: ${res.text}`);
        assertErrorBody(res, reqPath);
      }
    });
  });

  test('wrong method on a known /api route -> 405 JSON {error, code}', async () => {
    const planRoutes = fakePlanRoutes();
    await withServer({ cameraSource: fakeSource(), router: fakeRouter(), planRoutes }, async (port) => {
      const cases = [
        ['POST', '/api/health'],
        ['POST', '/api/config'],
        ['POST', '/api/cameras?bbox=33.7,-84.4,33.8,-84.3'],
        ['GET', '/api/route'],
        ['DELETE', '/api/route'],
      ];
      for (const [method, reqPath] of cases) {
        const res = await request(port, { method, path: reqPath, body: method === 'POST' ? '{}' : undefined });
        assert.equal(res.status, 405, `${method} ${reqPath}: ${res.text}`);
        assertErrorBody(res, `${method} ${reqPath}`);
      }
      assert.equal(planRoutes.calls.length, 0);
    });
  });
});

// ================================================================ static files

describe('static files', () => {
  const deps = () => ({ cameraSource: fakeSource(), router: fakeRouter(), planRoutes: fakePlanRoutes() });

  test('static: GET / serves publicDir/index.html', async () => {
    await withServer(deps(), async (port) => {
      const res = await request(port, { path: '/' });
      assert.equal(res.status, 200);
      assert.equal(res.text, FILES['index.html']);
    });
  });

  test('static: GET /<file> serves that file from publicDir, including subfolders', async () => {
    await withServer(deps(), async (port) => {
      for (const rel of ['index.html', 'style.css', 'app.js', 'js/nested.js']) {
        const res = await request(port, { path: `/${rel}` });
        assert.equal(res.status, 200, `/${rel}`);
        assert.equal(res.text, FILES[rel], `/${rel} body`);
      }
    });
  });

  test('static: without publicDir it serves the project public/ folder (DEFAULT_PUBLIC_DIR)', async () => {
    const libJs = fs.readFileSync(new URL('../../public/lib.js', import.meta.url), 'utf8');
    await withServer(
      deps(),
      async (port) => {
        const res = await request(port, { path: '/lib.js' });
        assert.equal(res.status, 200, res.text);
        assert.equal(res.text, libJs);
      },
      { defaultPublicDir: true },
    );
  });

  test('static: publicDir may be given as a file URL', async () => {
    const publicDir = pathToFileURL(PUBLIC_DIR + path.sep);
    await withServer({ ...deps(), publicDir }, async (port) => {
      const res = await request(port, { path: '/style.css' });
      assert.equal(res.status, 200);
      assert.equal(res.text, FILES['style.css']);
    });
  });

  test('static: html, css and js are served with Content-Types a browser accepts', async () => {
    await withServer(deps(), async (port) => {
      const html = await request(port, { path: '/' });
      const css = await request(port, { path: '/style.css' });
      const js = await request(port, { path: '/app.js' });
      assert.match(String(html.headers['content-type']), /^text\/html/, 'index.html');
      assert.match(String(css.headers['content-type']), /^text\/css/, 'style.css');
      assert.match(String(js.headers['content-type']), /^(text|application)\/javascript/, 'app.js (needed for ES modules)');
    });
  });

  test('static: a missing file -> 404', async () => {
    await withServer(deps(), async (port) => {
      for (const reqPath of ['/nope.html', '/js/nope.js']) {
        const res = await request(port, { path: reqPath });
        assert.equal(res.status, 404, reqPath);
      }
    });
  });

  test('static: paths escaping publicDir -> 404 and nothing outside it leaks', async () => {
    const traversal = [
      '/../secret.txt',
      '/js/../../secret.txt',
      '/%2e%2e/secret.txt',
      '/%2E%2E/secret.txt',
      '/..%2fsecret.txt',
      '/%2e%2e%2fsecret.txt',
      '/js/..%2f..%2fsecret.txt',
      '/../public-evil/leak.txt',
      '/%2e%2e/public-evil/leak.txt',
      // Encoded slashes reach the sibling folder "public-evil": catches startsWith(publicDir) without a separator.
      '/..%2fpublic-evil%2fleak.txt',
      // An absolute path, percent-encoded: catches path.resolve(publicDir, decoded).
      `/${encodeURIComponent(path.join(TMP_ROOT, 'secret.txt'))}`,
    ];
    await withServer(deps(), async (port) => {
      for (const reqPath of traversal) {
        const res = await request(port, { path: reqPath });
        assert.equal(res.status, 404, `${reqPath}: ${res.status} ${res.text}`);
        assert.ok(!res.text.includes(SECRET_MARKER), `${reqPath} leaked a file outside publicDir`);
      }
    });
  });

  test('static: a path with a NUL byte gets an error status and the server keeps serving', async (t) => {
    muteConsole(t);
    await withServer(deps(), async (port) => {
      const res = await request(port, { path: '/index.html%00.txt' });
      assert.ok(res.status >= 400 && res.status < 600, `expected an error status, got ${res.status}`);
      const again = await request(port, { path: '/api/health' });
      assert.equal(again.status, 200, 'server should still answer');
    });
  });
});

// ================================================================ main.js: configFromEnv

describe('configFromEnv', () => {
  test('configFromEnv: defaults are host 127.0.0.1, port 8080, cameras "overpass", router "valhalla"', () => {
    const cfg = configFromEnv({});
    assert.equal(cfg.host, '127.0.0.1');
    assert.equal(cfg.port, 8080);
    assert.equal(cfg.cameraSource.name, 'overpass');
    assert.equal(cfg.router.name, 'valhalla');
    assert.equal(typeof cfg.cameraSource.getCameras, 'function');
    assert.equal(typeof cfg.router.route, 'function');
  });

  test('configFromEnv: PORT and HOST are read from env (PORT as a number)', () => {
    const cfg = configFromEnv({ PORT: '9123', HOST: '0.0.0.0' });
    assert.equal(cfg.port, 9123);
    assert.equal(cfg.host, '0.0.0.0');
  });

  test('configFromEnv: CAMERA_SOURCE=overpass ROUTER=valhalla pick the live implementations', () => {
    const cfg = configFromEnv({ CAMERA_SOURCE: 'overpass', ROUTER: 'valhalla' });
    assert.equal(cfg.cameraSource.name, 'overpass');
    assert.equal(cfg.router.name, 'valhalla');
  });

  test('configFromEnv: ROUTER=stub picks the stub router', () => {
    const cfg = configFromEnv({ ROUTER: 'stub' });
    assert.equal(cfg.router.name, 'stub');
    assert.equal(cfg.cameraSource.name, 'overpass');
  });

  test('configFromEnv: CAMERA_SOURCE=fixture picks the fixture source', (t) => {
    if (!camerasBuilt()) {
      t.skip('cameras module not built yet (loadSampleCameras throws NotImplementedError)');
      return;
    }
    const cfg = configFromEnv({ CAMERA_SOURCE: 'fixture' });
    assert.equal(cfg.cameraSource.name, 'fixture');
    assert.equal(cfg.router.name, 'valhalla');
  });

  test('configFromEnv: OFFLINE=1 means fixture cameras and stub router', (t) => {
    if (!camerasBuilt()) {
      t.skip('cameras module not built yet (loadSampleCameras throws NotImplementedError)');
      return;
    }
    const cfg = configFromEnv({ OFFLINE: '1' });
    assert.equal(cfg.cameraSource.name, 'fixture');
    assert.equal(cfg.router.name, 'stub');
  });

  test('configFromEnv: CONTACT is added to the User-Agent of the Overpass source and Valhalla router', async () => {
    const contact = 'acceptance-tester@example.com';
    const code = `
      import { configFromEnv } from ${JSON.stringify(pathToFileURL(MAIN_JS).href)};
      const cfg = configFromEnv(process.env);
      console.log(JSON.stringify({ source: cfg.cameraSource.userAgent ?? null, router: cfg.router.userAgent ?? null }));
    `;
    const out = await runSnippet(code, { CONTACT: contact });
    assert.ok(String(out.source).includes(contact), `Overpass User-Agent should include CONTACT, got ${out.source}`);
    assert.ok(String(out.router).includes(contact), `Valhalla User-Agent should include CONTACT, got ${out.router}`);
  });
});

// ================================================================ main.js: process behavior

describe('main', () => {
  for (const [label, env] of [
    ['CAMERA_SOURCE', { CAMERA_SOURCE: 'bogus-source' }],
    ['ROUTER', { ROUTER: 'bogus-router' }],
  ]) {
    test(`main: an unknown ${label} exits with code 1 and a message`, { timeout: 15_000 }, async () => {
      const port = await freePort();
      const r = await runMain({ ...env, PORT: String(port), HOST: '127.0.0.1' });
      assert.equal(r.timedOut, false, `process should exit on its own; stdout: ${r.stdout}`);
      assert.equal(r.code, 1, `exit code; stderr: ${r.stderr}`);
      const output = (r.stderr + r.stdout).trim();
      assert.ok(output.length > 0, 'should print a message');
      assert.doesNotMatch(output, /not implemented/i, 'message should come from main, not a NotImplementedError stub');
      assert.doesNotMatch(r.stdout, /ALPR Route Planner on http/, 'should not start the server');
    });
  }

  test('main: prints "ALPR Route Planner on http://<host>:<port> (cameras: <name>, router: <name>)" and serves the API there', { timeout: 20_000 }, async (t) => {
    if (!camerasBuilt()) {
      t.skip('cameras module not built yet (needed for OFFLINE=1)');
      return;
    }
    const port = await freePort();
    const expected = `ALPR Route Planner on http://127.0.0.1:${port} (cameras: fixture, router: stub)`;
    let health = null;
    const r = await runMain(
      { OFFLINE: '1', PORT: String(port), HOST: '127.0.0.1' },
      {
        timeoutMs: 10_000,
        onLine: async (line) => {
          if (!line.includes('ALPR Route Planner on')) return false;
          try {
            health = await request(port, { path: '/api/health' });
          } catch (err) {
            health = { error: String(err) };
          }
          return true;
        },
      },
    );
    assert.ok(r.matched, `start line not printed; stdout: ${r.stdout} stderr: ${r.stderr}`);
    assert.equal(r.matched.trim(), expected);
    assert.ok(health && health.status === 200, `GET /api/health on the printed port failed: ${JSON.stringify(health)}`);
    assert.equal(health.json.ok, true);
    assert.equal(health.json.cameraSource, 'fixture');
    assert.equal(health.json.router, 'stub');
  });
});
