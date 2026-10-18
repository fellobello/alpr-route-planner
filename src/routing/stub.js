// @ts-check
/**
 * Offline router that needs no network. Not real roads: it draws straight lines and dog-legs
 * so the app and planner can be demoed and tested without Valhalla.
 * INTERFACE FILE: exported names, signatures and documented behavior are fixed.
 */
import { InputError } from '../types.js';
import { EARTH_RADIUS_M, lineLengthM, pointToPolylineM } from '../geo.js';

/** @typedef {import('../types.js').Route} Route */
/** @typedef {import('../types.js').RouteRequest} RouteRequest */
/** @typedef {import('../types.js').Router} Router */
/** @typedef {import('../types.js').LatLng} LatLng */
/** @typedef {import('../types.js').LatLonPair} LatLonPair */

/** Speed the stub assumes, for durationS. */
export const STUB_SPEED_MPS = 40_000 / 3600;

/** Perpendicular offsets tried for a dog-leg, nearest first. */
export const STUB_OFFSETS_M = [500, 1000, 2000, 4000];

/** @implements {Router} */
export class StubRouter {
  constructor() {
    this.name = 'stub';
    this.maxAvoid = 50;
  }

  /**
   * Deterministic fake route:
   *  1. The straight line [start, end] if no avoid point is within avoidRadiusM of it.
   *  2. Otherwise a dog-leg [start, waypoint, end], where waypoint is the midpoint of start-end
   *     moved perpendicular by each STUB_OFFSETS_M value, left side then right side, nearest first.
   *     Return the first dog-leg with no avoid point within avoidRadiusM.
   *  3. If none is clear, the dog-leg with the fewest avoid points within avoidRadiusM (first wins ties).
   * distanceM = length of points (haversine), durationS = distanceM / STUB_SPEED_MPS.
   * Rejects with InputError when avoid.length > maxAvoid; never rejects with NoRouteError.
   * @param {RouteRequest} req
   * @returns {Promise<Route>}
   */
  async route(req) {
    if (!req || typeof req !== 'object') throw new InputError('route request must be an object');
    const start = checkPoint(req.start, 'start');
    const end = checkPoint(req.end, 'end');
    const avoid = checkAvoid(req.avoid, this.maxAvoid);
    const radius = avoid.length > 0 ? checkRadius(req.avoidRadiusM) : 0;

    /** @type {LatLonPair[]} */
    const straight = [
      [start.lat, start.lon],
      [end.lat, end.lon],
    ];
    if (countHits(avoid, straight, radius) === 0) return toRoute(straight);

    /** @type {LatLonPair[] | null} */
    let best = null;
    let bestHits = Infinity;
    for (const { side, offsetM } of dogLegCandidates()) {
      const wp = perpendicularWaypoint(start, end, side * offsetM);
      /** @type {LatLonPair[]} */
      const line = [straight[0], [wp.lat, wp.lon], straight[1]];
      const hits = countHits(avoid, line, radius);
      if (hits === 0) return toRoute(line);
      if (hits < bestHits) {
        best = line;
        bestHits = hits;
      }
    }
    return toRoute(/** @type {LatLonPair[]} */ (best));
  }
}

// ---- internal helpers ----

const DEG = Math.PI / 180;
const M_PER_DEG = EARTH_RADIUS_M * DEG;

/**
 * Dog-leg candidates in the documented order: each offset nearest first, left (+1) then right (-1).
 * @returns {{side: 1 | -1, offsetM: number}[]}
 */
function dogLegCandidates() {
  return STUB_OFFSETS_M.flatMap((offsetM) => [
    { side: /** @type {1} */ (1), offsetM },
    { side: /** @type {-1} */ (-1), offsetM },
  ]);
}

/**
 * The start-end midpoint moved offsetM perpendicular to the direction of travel: positive is to
 * the left (90 degrees counter-clockwise from start->end), negative to the right. Uses a local
 * flat frame around the midpoint, fine for trips up to MAX_TRIP_M. When start equals end there
 * is no direction, so travel is taken as due east (left is north).
 * @param {LatLng} start
 * @param {LatLng} end
 * @param {number} offsetM
 * @returns {LatLng}
 */
function perpendicularWaypoint(start, end, offsetM) {
  const dLon = wrapDeltaLon(end.lon - start.lon);
  const midLat = (start.lat + end.lat) / 2;
  const midLon = normalizeLon(start.lon + dLon / 2);
  const k = Math.cos(midLat * DEG);
  const dx = dLon * k * M_PER_DEG; // meters east
  const dy = (end.lat - start.lat) * M_PER_DEG; // meters north
  const len = Math.hypot(dx, dy);
  const ax = len > 0 ? dx / len : 1;
  const ay = len > 0 ? dy / len : 0;
  // Left of (ax, ay) is (-ay, ax).
  const x = -ay * offsetM;
  const y = ax * offsetM;
  const lat = Math.max(-90, Math.min(90, midLat + y / M_PER_DEG));
  const lon = k > 1e-12 ? normalizeLon(midLon + x / (M_PER_DEG * k)) : midLon;
  return { lat, lon };
}

/**
 * Number of avoid points within radiusM of the line.
 * @param {LatLng[]} avoid
 * @param {LatLonPair[]} line
 * @param {number} radiusM
 */
function countHits(avoid, line, radiusM) {
  let n = 0;
  for (const p of avoid) if (pointToPolylineM(p, line) <= radiusM) n++;
  return n;
}

/**
 * @param {LatLonPair[]} points
 * @returns {Route}
 */
function toRoute(points) {
  const distanceM = lineLengthM(points);
  return { points, distanceM, durationS: distanceM / STUB_SPEED_MPS };
}

/** @param {number} d degrees */
function wrapDeltaLon(d) {
  if (d >= -180 && d < 180) return d;
  return ((((d + 180) % 360) + 360) % 360) - 180;
}

/** @param {number} lon degrees */
function normalizeLon(lon) {
  if (lon >= -180 && lon <= 180) return lon;
  return wrapDeltaLon(lon);
}

/**
 * @param {unknown} p
 * @param {string} what
 * @returns {LatLng}
 */
function checkPoint(p, what) {
  const q = /** @type {any} */ (p);
  if (
    typeof q !== 'object' ||
    q === null ||
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
 * The avoid list, each point checked (missing means none). InputError when not an array or too long.
 * @param {unknown} avoid
 * @param {number} max
 * @returns {LatLng[]}
 */
function checkAvoid(avoid, max) {
  if (avoid === undefined || avoid === null) return [];
  if (!Array.isArray(avoid)) throw new InputError('avoid must be an array of {lat, lon}');
  if (avoid.length > max) {
    throw new InputError(`at most ${max} avoid points are allowed, got ${avoid.length}`);
  }
  return avoid.map((p, i) => checkPoint(p, `avoid[${i}]`));
}

/**
 * @param {unknown} r
 * @returns {number}
 */
function checkRadius(r) {
  if (typeof r !== 'number' || !Number.isFinite(r) || r < 0) {
    throw new InputError('avoidRadiusM must be a finite number >= 0');
  }
  return r;
}
