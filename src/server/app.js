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
import { NotImplementedError } from '../types.js';

/** @typedef {import('../types.js').BBox} BBox */
/** @typedef {import('../types.js').CameraSource} CameraSource */
/** @typedef {import('../types.js').Router} Router */
/** @typedef {import('../types.js').PlanRequest} PlanRequest */
/** @typedef {import('../types.js').RoutePlan} RoutePlan */

export const DEFAULT_PUBLIC_DIR = new URL('../../public/', import.meta.url);

/**
 * Parse "south,west,north,east" (decimal degrees). Throws InputError when it is not exactly
 * four finite numbers, south > north, west > east, out of range, or either span exceeds
 * MAX_BBOX_SPAN_DEG.
 * @param {string|null|undefined} text
 * @returns {BBox}
 */
export function parseBbox(text) {
  throw new NotImplementedError('api.parseBbox');
}

/**
 * HTTP status for an error thrown by a handler: TripTooLongError 422, InputError 400,
 * NoRouteError 422, UpstreamError 502, anything else 500.
 * @param {unknown} err
 * @returns {number}
 */
export function errorStatus(err) {
  throw new NotImplementedError('api.errorStatus');
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
  throw new NotImplementedError('api.createServer');
}
