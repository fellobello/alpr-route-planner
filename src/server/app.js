// @ts-check
/**
 * HTTP API and static file server (node:http, no framework). INTERFACE FILE: exported names,
 * signatures, routes and response shapes are fixed; the api module's builder fills in bodies.
 *
 * Routes (all JSON responses use Content-Type: application/json; charset=utf-8):
 *   GET  /api/health                 200 {ok: true, cameraSource: <name>, router: <name>}
 *   GET  /api/config                 200 ClientConfig (see types.js)
 *   GET  /api/cameras?bbox=S,W,N,E   200 {cameras: Camera[], source: <cameraSource.name>}
 *                                    400 when bbox is missing/malformed, south > north, west > east,
 *                                        or a side spans more than MAX_BBOX_SPAN_DEG
 *   POST /api/route   body PlanRequest (JSON, at most 10 kB)
 *                                    200 RoutePlan
 *                                    400 bad JSON or InputError, 413 body too large,
 *                                    422 TripTooLongError or NoRouteError, 502 UpstreamError
 *   GET  /, /<file>                  static files from publicDir ("/" serves index.html);
 *                                    paths escaping publicDir or missing files -> 404
 *   other /api/* or wrong method     404 / 405 as JSON
 * Every error response body is {error: <message>, code: <err.code or "INTERNAL">};
 * unexpected errors are 500 and are logged without crashing the server.
 */
import http from 'node:http';
import path from 'node:path';
import { readFile, realpath, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  APP_TITLE,
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
  TripTooLongError,
  UpstreamError,
} from '../types.js';
import { planRoutes as defaultPlanRoutes } from '../planner.js';

/** @typedef {import('../types.js').BBox} BBox */
/** @typedef {import('../types.js').CameraSource} CameraSource */
/** @typedef {import('../types.js').Router} Router */
/** @typedef {import('../types.js').PlanRequest} PlanRequest */
/** @typedef {import('../types.js').RoutePlan} RoutePlan */
/** @typedef {import('../types.js').ClientConfig} ClientConfig */

export const DEFAULT_PUBLIC_DIR = new URL('../../public/', import.meta.url);

/** Largest accepted POST /api/route body, in bytes ("10 kB", SI). */
export const MAX_BODY_BYTES = 10_000;

const JSON_TYPE = 'application/json; charset=utf-8';

/** Rounding slack for the bbox span check, so a client's 0.5-degree box is not refused over 1e-15. */
const SPAN_EPSILON_DEG = 1e-9;

/** A plain decimal number: optional sign, digits with optional fraction, optional exponent. */
const DECIMAL_RE = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/;

/** Content types for files served from publicDir; anything else is application/octet-stream. */
const CONTENT_TYPES = /** @type {Record<string, string>} */ ({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
});

/** An HTTP-level failure that is not one of the shared error classes (404, 405, 413). */
class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   * @param {Record<string, string>} [headers]
   */
  constructor(status, code, message, headers = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

/**
 * Parse "south,west,north,east" (decimal degrees). Throws InputError when it is not exactly
 * four finite numbers, south > north, west > east, out of range, or either span exceeds
 * MAX_BBOX_SPAN_DEG.
 * @param {string|null|undefined} text
 * @returns {BBox}
 */
export function parseBbox(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new InputError('bbox is required as south,west,north,east');
  }
  const parts = text.split(',').map((p) => p.trim());
  if (parts.length !== 4) {
    throw new InputError(`bbox must have 4 numbers (south,west,north,east), got ${parts.length}`);
  }
  const nums = parts.map((p) => (DECIMAL_RE.test(p) ? Number(p) : NaN));
  if (!nums.every(Number.isFinite)) {
    throw new InputError('bbox must be 4 decimal numbers: south,west,north,east');
  }
  const [south, west, north, east] = nums;
  if (south < -90 || south > 90 || north < -90 || north > 90) {
    throw new InputError('bbox latitudes must be between -90 and 90');
  }
  if (west < -180 || west > 180 || east < -180 || east > 180) {
    throw new InputError('bbox longitudes must be between -180 and 180');
  }
  if (south > north) throw new InputError('bbox south must not be greater than north');
  if (west > east) throw new InputError('bbox west must not be greater than east');
  if (north - south > MAX_BBOX_SPAN_DEG + SPAN_EPSILON_DEG || east - west > MAX_BBOX_SPAN_DEG + SPAN_EPSILON_DEG) {
    throw new InputError(`bbox is too large: each side may span at most ${MAX_BBOX_SPAN_DEG} degrees; zoom in`);
  }
  return { south, west, north, east };
}

/**
 * HTTP status for an error thrown by a handler: TripTooLongError 422, InputError 400,
 * NoRouteError 422, UpstreamError 502, anything else 500.
 * @param {unknown} err
 * @returns {number}
 */
export function errorStatus(err) {
  // TripTooLongError extends InputError, so it must be checked first.
  if (err instanceof TripTooLongError) return 422;
  if (err instanceof InputError) return 400;
  if (err instanceof NoRouteError) return 422;
  if (err instanceof UpstreamError) return 502;
  return 500;
}

/**
 * Build (but do not start) the server.
 * @param {Object} deps
 * @param {CameraSource} deps.cameraSource
 * @param {Router} deps.router
 * @param {(req: PlanRequest, deps: {cameraSource: CameraSource, router: Router}) => Promise<RoutePlan>} [deps.planRoutes]
 *        defaults to planRoutes from ../planner.js; tests inject a fake
 * @param {string|URL} [deps.publicDir=DEFAULT_PUBLIC_DIR]
 * @returns {import('node:http').Server}
 */
export function createServer(deps) {
  const { cameraSource, router } = deps;
  const plan = deps.planRoutes ?? defaultPlanRoutes;
  const publicRoot = path.resolve(toPath(deps.publicDir ?? DEFAULT_PUBLIC_DIR));

  /** @type {Record<string, Record<string, (req: http.IncomingMessage, url: URL) => Promise<unknown>>>} */
  const apiRoutes = {
    '/api/health': {
      GET: async () => ({ ok: true, cameraSource: cameraSource.name, router: router.name }),
    },
    '/api/config': {
      GET: async () => clientConfig(cameraSource, router),
    },
    '/api/cameras': {
      GET: async (_req, url) => {
        const bbox = parseBbox(url.searchParams.get('bbox'));
        const cameras = await cameraSource.getCameras(bbox);
        return { cameras, source: cameraSource.name };
      },
    },
    '/api/route': {
      POST: async (req) => {
        const body = parseJsonBody(await readBody(req, MAX_BODY_BYTES));
        return plan(/** @type {PlanRequest} */ (body), { cameraSource, router });
      },
    },
  };

  /**
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   */
  async function handle(req, res) {
    try {
      const url = parseUrl(req.url);
      const method = req.method === 'HEAD' ? 'GET' : req.method ?? 'GET';
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        const route = apiRoutes[url.pathname];
        if (!route) throw new HttpError(404, 'NOT_FOUND', `No API endpoint ${url.pathname}`);
        const handler = route[method];
        if (!handler) {
          const allow = Object.keys(route).flatMap((m) => (m === 'GET' ? ['GET', 'HEAD'] : [m])).join(', ');
          throw new HttpError(405, 'METHOD_NOT_ALLOWED', `${req.method} is not allowed on ${url.pathname}`, {
            Allow: allow,
          });
        }
        sendJson(res, 200, await handler(req, url));
        return;
      }
      if (method !== 'GET') {
        throw new HttpError(405, 'METHOD_NOT_ALLOWED', `${req.method} is not allowed here`, { Allow: 'GET, HEAD' });
      }
      await serveStatic(res, publicRoot, url.pathname);
    } catch (err) {
      sendError(res, err);
    }
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      // Only reached if sending the error response itself failed; never let it crash the process.
      console.error('[api] failed to send a response:', err);
      if (!res.destroyed) res.destroy();
    });
  });
}

// ---- helpers ----

/**
 * @param {string|URL} dir
 * @returns {string}
 */
function toPath(dir) {
  if (dir instanceof URL) return fileURLToPath(dir);
  if (dir.startsWith('file:')) return fileURLToPath(dir);
  return dir;
}

/**
 * @param {string|undefined} rawUrl
 * @returns {URL}
 */
function parseUrl(rawUrl) {
  const target = rawUrl || '/';
  try {
    // Origin-form targets ("/x") are appended to a fixed origin, so "//host/x" stays a path
    // instead of being read as a protocol-relative URL with host "host".
    return target.startsWith('/') ? new URL(`http://localhost${target}`) : new URL(target, 'http://localhost');
  } catch {
    throw new InputError('Malformed request URL');
  }
}

/**
 * @param {CameraSource} cameraSource
 * @param {Router} router
 * @returns {ClientConfig}
 */
function clientConfig(cameraSource, router) {
  return {
    center: { lat: DEFAULT_CENTER.lat, lon: DEFAULT_CENTER.lon },
    zoom: DEFAULT_ZOOM,
    minCameraZoom: MIN_CAMERA_ZOOM,
    defaultBufferM: DEFAULT_BUFFER_M,
    minBufferM: MIN_BUFFER_M,
    maxBufferM: MAX_BUFFER_M,
    maxTripM: MAX_TRIP_M,
    maxBboxSpanDeg: MAX_BBOX_SPAN_DEG,
    cameraSource: cameraSource.name,
    router: router.name,
    appTitle: APP_TITLE,
  };
}

/**
 * Read the whole request body as UTF-8, refusing more than `limit` bytes with a 413.
 * @param {http.IncomingMessage} req
 * @param {number} limit
 * @returns {Promise<string>}
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const tooLarge = () =>
      new HttpError(413, 'BODY_TOO_LARGE', `Request body is larger than ${limit} bytes`, { Connection: 'close' });
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      reject(tooLarge());
      return;
    }
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on('data', (/** @type {Buffer} */ chunk) => {
      if (settled) return; // keep draining, discard
      size += chunk.length;
      if (size > limit) {
        settled = true;
        reject(tooLarge());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    req.on('close', () => {
      if (settled) return;
      settled = true;
      reject(new InputError('Request body was cut off'));
    });
  });
}

/**
 * @param {string} text
 * @returns {Record<string, unknown>}
 */
function parseJsonBody(text) {
  if (text.trim() === '') throw new InputError('Request body must be a JSON object');
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new InputError('Request body is not valid JSON');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InputError('Request body must be a JSON object');
  }
  return value;
}

/**
 * Serve one file from root. Anything that is missing, a directory, a dotfile, or resolves
 * (also through symlinks) outside root is a 404.
 * @param {http.ServerResponse} res
 * @param {string} root  absolute publicDir
 * @param {string} pathname  URL pathname, still percent-encoded
 */
async function serveStatic(res, root, pathname) {
  const notFound = () => new HttpError(404, 'NOT_FOUND', 'Not found');
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw notFound();
  }
  if (decoded.endsWith('/')) decoded += 'index.html';
  const segments = decoded.split(/[/\\]/).filter((s) => s !== '');
  if (decoded.includes('\0') || segments.some((s) => s.startsWith('.'))) throw notFound();

  let realRoot;
  try {
    realRoot = await realpath(root);
  } catch {
    throw notFound();
  }
  const candidate = path.resolve(realRoot, ...segments);
  if (!isInside(realRoot, candidate)) throw notFound();

  let filePath;
  let data;
  try {
    filePath = await realpath(candidate);
    if (!isInside(realRoot, filePath)) throw notFound();
    if (!(await stat(filePath)).isFile()) throw notFound();
    data = await readFile(filePath);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    const code = /** @type {{code?: string}} */ (err).code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR' || code === 'EACCES' || code === 'ELOOP') {
      throw notFound();
    }
    throw err;
  }
  res.writeHead(200, {
    'Content-Type': CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': data.length,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(data);
}

/**
 * @param {string} root
 * @param {string} p
 */
function isInside(root, p) {
  const rel = path.relative(root, p);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 * @param {Record<string, string>} [headers]
 */
function sendJson(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': JSON_TYPE,
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(text);
}

/**
 * Turn any thrown value into an {error, code} response. 500s are logged with their stack.
 * @param {http.ServerResponse} res
 * @param {unknown} err
 */
function sendError(res, err) {
  const status = err instanceof HttpError ? err.status : errorStatus(err);
  if (status === 500) {
    console.error('[api] unexpected error:', err);
  } else if (status === 502) {
    console.warn(`[api] upstream failure: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const errCode = /** @type {{code?: unknown}} */ (err ?? {}).code;
  const code = status !== 500 && typeof errCode === 'string' ? errCode : 'INTERNAL';
  const message = err instanceof Error && err.message ? err.message : 'Internal server error';
  const headers = err instanceof HttpError ? err.headers : {};
  sendJson(res, status, { error: message, code }, headers);
}
