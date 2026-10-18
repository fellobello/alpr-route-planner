// @ts-check
/**
 * Routing through a Valhalla server (default: the free FOSSGIS public instance).
 * INTERFACE FILE: exported names, signatures and documented behavior are fixed;
 * the routing module's builder fills in bodies.
 */
import { USER_AGENT, InputError, NoRouteError, UpstreamError } from '../types.js';
import { decodePolyline } from '../geo.js';

/** @typedef {import('../types.js').Route} Route */
/** @typedef {import('../types.js').RouteRequest} RouteRequest */
/** @typedef {import('../types.js').Router} Router */
/** @typedef {import('../types.js').LatLng} LatLng */
/** @typedef {import('../types.js').LatLonPair} LatLonPair */

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
  if (!req || typeof req !== 'object') throw new InputError('route request must be an object');
  const start = checkPoint(req.start, 'start');
  const end = checkPoint(req.end, 'end');
  const avoid = checkAvoid(req.avoid, VALHALLA_MAX_AVOID);
  /** @type {Record<string, unknown>} */
  const body = {
    locations: [
      { lat: start.lat, lon: start.lon },
      { lat: end.lat, lon: end.lon },
    ],
    costing: 'auto',
    units: 'kilometers',
    directions_type: 'none',
  };
  if (avoid.length > 0) {
    const radius = checkRadius(req.avoidRadiusM);
    body.exclude_locations = avoid.map((p, i) => {
      const q = checkPoint(p, `avoid[${i}]`);
      return { lat: q.lat, lon: q.lon, radius };
    });
  }
  return body;
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
  const trip = isObject(json) ? json.trip : undefined;
  if (!isObject(trip)) throw new UpstreamError('valhalla', 'response has no trip');
  const { legs, summary } = trip;
  if (!Array.isArray(legs) || legs.length === 0) {
    throw new UpstreamError('valhalla', 'trip has no legs');
  }
  if (!isObject(summary)) throw new UpstreamError('valhalla', 'trip has no summary');
  const lengthKm = summary.length;
  const timeS = summary.time;
  if (!isNonNegativeNumber(lengthKm) || !isNonNegativeNumber(timeS)) {
    throw new UpstreamError('valhalla', 'trip summary has no usable length or time');
  }

  /** @type {LatLonPair[]} */
  const points = [];
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    const shape = isObject(leg) ? leg.shape : undefined;
    if (typeof shape !== 'string') throw new UpstreamError('valhalla', `leg ${i} has no shape`);
    /** @type {LatLonPair[]} */
    let decoded;
    try {
      decoded = decodePolyline(shape, 6);
    } catch (err) {
      throw new UpstreamError('valhalla', `leg ${i} shape is not a valid polyline: ${errorMessage(err)}`);
    }
    // Each leg after the first starts where the previous one ended; keep that joint once.
    const from = points.length > 0 && decoded.length > 0 && samePoint(points[points.length - 1], decoded[0]) ? 1 : 0;
    for (let j = from; j < decoded.length; j++) points.push(decoded[j]);
  }
  if (points.length < 2) throw new UpstreamError('valhalla', 'trip shape has fewer than 2 points');

  return { points, distanceM: lengthKm * 1000, durationS: timeS };
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
    // Check the cap first: maxAvoid may be set lower than VALHALLA_MAX_AVOID.
    if (req && Array.isArray(req.avoid) && req.avoid.length > this.maxAvoid) {
      throw new InputError(`at most ${this.maxAvoid} avoid points are allowed, got ${req.avoid.length}`);
    }
    const body = buildValhallaRequest(req);

    const doFetch = this.fetch;
    if (typeof doFetch !== 'function') throw new UpstreamError('valhalla', 'no fetch function available');

    /** @type {Response} */
    let res;
    try {
      res = await doFetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': this.userAgent,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new UpstreamError('valhalla', `request failed: ${errorMessage(err)}`);
    }

    /** @type {string} */
    let text;
    try {
      text = await res.text();
    } catch (err) {
      throw new UpstreamError('valhalla', `could not read the response: ${errorMessage(err)}`);
    }

    /** @type {unknown} */
    let json;
    let parsed = false;
    try {
      json = JSON.parse(text);
      parsed = true;
    } catch {
      // handled below
    }

    if (!res.ok) {
      if (res.status === 400 && parsed && isObject(json) && NO_ROUTE_CODES.has(Number(json.error_code))) {
        const detail = typeof json.error === 'string' && json.error ? json.error : 'no route found';
        throw new NoRouteError(`No route found: ${detail} (Valhalla error ${json.error_code})`);
      }
      throw new UpstreamError('valhalla', `HTTP ${res.status}${upstreamDetail(parsed ? json : undefined)}`);
    }
    if (!parsed) throw new UpstreamError('valhalla', 'response is not valid JSON');
    return parseValhallaResponse(json);
  }
}

// ---- internal helpers ----

/** Valhalla error codes that mean "there is no route", not "the service failed". */
const NO_ROUTE_CODES = new Set([442, 171]);

/**
 * @param {unknown} v
 * @returns {v is Record<string, any>}
 */
function isObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** @param {unknown} v */
function isNonNegativeNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/**
 * @param {unknown} p
 * @param {string} what
 * @returns {LatLng}
 */
function checkPoint(p, what) {
  const q = /** @type {any} */ (p);
  if (
    !isObject(q) ||
    typeof q.lat !== 'number' ||
    typeof q.lon !== 'number' ||
    !Number.isFinite(q.lat) ||
    !Number.isFinite(q.lon) ||
    q.lat < -90 ||
    q.lat > 90 ||
    q.lon < -180 ||
    q.lon > 180
  ) {
    throw new InputError(`${what} must be {lat, lon} with lat in [-90, 90] and lon in [-180, 180]`);
  }
  return q;
}

/**
 * The avoid list as an array (missing means none). InputError when it is not an array or too long.
 * @param {unknown} avoid
 * @param {number} max
 * @returns {unknown[]}
 */
function checkAvoid(avoid, max) {
  if (avoid === undefined || avoid === null) return [];
  if (!Array.isArray(avoid)) throw new InputError('avoid must be an array of {lat, lon}');
  if (avoid.length > max) {
    throw new InputError(`at most ${max} avoid points are allowed, got ${avoid.length}`);
  }
  return avoid;
}

/**
 * @param {unknown} r
 * @returns {number} meters, rounded
 */
function checkRadius(r) {
  if (typeof r !== 'number' || !Number.isFinite(r) || r < 0) {
    throw new InputError('avoidRadiusM must be a finite number >= 0');
  }
  return Math.round(r);
}

/**
 * @param {LatLonPair} a
 * @param {LatLonPair} b
 */
function samePoint(a, b) {
  return a[0] === b[0] && a[1] === b[1];
}

/** @param {unknown} err */
function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * ": <Valhalla error text> (error <code>)" when the body is a Valhalla error, else "".
 * @param {unknown} json
 */
function upstreamDetail(json) {
  if (!isObject(json)) return '';
  const msg = typeof json.error === 'string' ? json.error : '';
  const code = json.error_code !== undefined ? ` (error ${json.error_code})` : '';
  return msg || code ? `: ${msg || 'error'}${code}` : '';
}
