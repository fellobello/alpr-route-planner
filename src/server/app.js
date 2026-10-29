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
 *   GET  /api/geocode?q=<text>[&near=lat,lon]
 *                                    200 {results: Place[]}; 400 when q is missing or too long,
 *                                        502 when the geocoder fails
 *   POST /api/route   body PlanRequest (JSON, at most 10 kB)
 *                                    200 RoutePlan
 *                                    400 bad JSON or InputError, 413 body too large,
 *                                    422 TripTooLongError or NoRouteError, 502 UpstreamError
 *   GET  /, /<file>                  static files from publicDir ("/" serves index.html);
 *                                    paths escaping publicDir or missing files -> 404
 *   other /api/* or wrong method     404 / 405 as JSON
 * Every error response body is {error: <message>, code: <err.code or "INTERNAL">};
 * unexpected errors are 500 and are logged without crashing the server.
 * The behavior behind each /api route lives in ../api.js; this file is the HTTP around it.
 */
import http from 'node:http';
import path from 'node:path';
import { readFile, realpath, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { InputError } from '../types.js';
import { createApi, errorStatus, parseBbox } from '../api.js';

export { errorStatus, parseBbox };

/** @typedef {import('../types.js').CameraSource} CameraSource */
/** @typedef {import('../types.js').Router} Router */
/** @typedef {import('../types.js').PlanRequest} PlanRequest */
/** @typedef {import('../types.js').RoutePlan} RoutePlan */
/** @typedef {import('../types.js').Geocoder} Geocoder */

export const DEFAULT_PUBLIC_DIR = new URL('../../public/', import.meta.url);

/** Largest accepted POST /api/route body, in bytes ("10 kB", SI). */
export const MAX_BODY_BYTES = 10_000;

const JSON_TYPE = 'application/json; charset=utf-8';

/** Content types for files served from publicDir; anything else is application/octet-stream. */
const CONTENT_TYPES = /** @type {Record<string, string>} */ ({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
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

/**
 * Sent with every page and file. Tiles are the only outside requests the page makes; the
 * default Referrer-Policy is kept because the OSM tile policy asks for a Referer.
 */
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': [
    "default-src 'self'",
    "img-src 'self' data: https://tile.openstreetmap.org",
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; '),
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'geolocation=(self), camera=(), microphone=()',
};

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
 * Build (but do not start) the server.
 * @param {Object} deps
 * @param {CameraSource} deps.cameraSource
 * @param {Router} deps.router
 * @param {Geocoder|null} [deps.geocoder]  place search; without one, /api/geocode only reads "lat, lon"
 * @param {(req: PlanRequest, deps: {cameraSource: CameraSource, router: Router}) => Promise<RoutePlan>} [deps.planRoutes]
 *        defaults to planRoutes from ../planner.js; tests inject a fake
 * @param {string|URL} [deps.publicDir=DEFAULT_PUBLIC_DIR]
 * @returns {import('node:http').Server}
 */
export function createServer(deps) {
  const api = createApi(deps);
  const publicRoot = path.resolve(toPath(deps.publicDir ?? DEFAULT_PUBLIC_DIR));

  /** @type {Record<string, Record<string, (req: http.IncomingMessage, url: URL) => Promise<unknown>>>} */
  const apiRoutes = {
    '/api/health': { GET: async () => api.health() },
    '/api/config': { GET: async () => api.config() },
    '/api/cameras': { GET: async (_req, url) => api.cameras(url.searchParams.get('bbox')) },
    '/api/geocode': {
      GET: async (_req, url) => api.geocode(url.searchParams.get('q'), url.searchParams.get('near')),
    },
    '/api/route': {
      POST: async (req) => api.route(parseJsonBody(await readBody(req, MAX_BODY_BYTES))),
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
    ...SECURITY_HEADERS,
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
