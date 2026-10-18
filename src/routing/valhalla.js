// @ts-check
/**
 * Routing through a Valhalla server (default: the free FOSSGIS public instance).
 * INTERFACE FILE: exported names, signatures and documented behavior are fixed;
 * the routing module's builder fills in bodies.
 */
import { USER_AGENT, NotImplementedError } from '../types.js';

/** @typedef {import('../types.js').Route} Route */
/** @typedef {import('../types.js').RouteRequest} RouteRequest */
/** @typedef {import('../types.js').Router} Router */

export const VALHALLA_ENDPOINT = 'https://valhalla1.openstreetmap.de/route';

/** Max avoid points sent in one request (Valhalla's default max_exclude_locations is 50). */
export const VALHALLA_MAX_AVOID = 50;

/**
 * Valhalla /route request body for a RouteRequest:
 *   { locations: [{lat, lon}, {lat, lon}], costing: "auto", units: "kilometers",
 *     directions_type: "none",
 *     exclude_locations: [{lat, lon, radius: <avoidRadiusM rounded>}, ...] }  // key omitted when avoid is empty
 * Throws InputError when avoid.length > VALHALLA_MAX_AVOID.
 * @param {RouteRequest} req
 * @returns {Record<string, unknown>}
 */
export function buildValhallaRequest(req) {
  throw new NotImplementedError('routing.buildValhallaRequest');
}

/**
 * Convert a Valhalla /route response to a Route: concatenate decoded trip.legs[].shape
 * (precision 6, dropping the duplicate joint point between legs), distanceM =
 * trip.summary.length * 1000, durationS = trip.summary.time.
 * Throws UpstreamError("valhalla", ...) when the trip is missing or malformed.
 * @param {unknown} json
 * @returns {Route}
 */
export function parseValhallaResponse(json) {
  throw new NotImplementedError('routing.parseValhallaResponse');
}

/** @implements {Router} */
export class ValhallaRouter {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.endpoint=VALHALLA_ENDPOINT]
   * @param {typeof fetch} [opts.fetch=globalThis.fetch]  injected so tests never touch the network
   * @param {string} [opts.userAgent=USER_AGENT]
   */
  constructor(opts = {}) {
    this.name = 'valhalla';
    this.maxAvoid = VALHALLA_MAX_AVOID;
    this.endpoint = opts.endpoint ?? VALHALLA_ENDPOINT;
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.userAgent = opts.userAgent ?? USER_AGENT;
  }

  /**
   * POST buildValhallaRequest(req) as JSON with the User-Agent header and parse the result.
   * Rejects with NoRouteError when Valhalla answers 400 with error_code 442 (no path) or
   * 171 (no road near a location); UpstreamError("valhalla", ...) on network failure,
   * any other non-2xx, or bad JSON; InputError when avoid.length > maxAvoid.
   * @param {RouteRequest} req
   * @returns {Promise<Route>}
   */
  async route(req) {
    throw new NotImplementedError('routing.ValhallaRouter.route');
  }
}
