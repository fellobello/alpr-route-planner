// @ts-check
/**
 * Plans a fastest route and a camera-avoiding route. INTERFACE FILE: exported names, signatures
 * and documented behavior are fixed; the planner module's builder fills in bodies.
 * Talks only to the CameraSource and Router it is given, so it works with real or fake ones.
 */
import {
  CORRIDOR_MARGIN_M,
  DEFAULT_BUFFER_M,
  InputError,
  MAX_AVOID_ITERATIONS,
  MAX_BUFFER_M,
  MAX_TRIP_M,
  MIN_BUFFER_M,
  NoRouteError,
  TripTooLongError,
} from './types.js';
import { bboxAround, bboxContains, bboxUnion, camerasNearRoute, haversineM } from './geo.js';

/** @typedef {import('./types.js').LatLng} LatLng */
/** @typedef {import('./types.js').BBox} BBox */
/** @typedef {import('./types.js').Camera} Camera */
/** @typedef {import('./types.js').Route} Route */
/** @typedef {import('./types.js').PlanRequest} PlanRequest */
/** @typedef {import('./types.js').RoutePlan} RoutePlan */
/** @typedef {import('./types.js').RouteResult} RouteResult */
/** @typedef {import('./types.js').CameraSource} CameraSource */
/** @typedef {import('./types.js').Router} Router */

// ---- internal helpers ----

/**
 * @param {unknown} p
 * @param {string} what  "start" | "end"
 * @returns {LatLng}  a fresh {lat, lon} with no extra fields
 */
function checkPoint(p, what) {
  const q = /** @type {any} */ (p);
  if (!q || typeof q !== 'object' || Array.isArray(q)) {
    throw new InputError(`${what} must be an object {lat, lon}`);
  }
  if (!Number.isFinite(q.lat) || !Number.isFinite(q.lon)) {
    throw new InputError(`${what} must be {lat, lon} with finite numbers`);
  }
  if (q.lat < -90 || q.lat > 90) throw new InputError(`${what}.lat must be between -90 and 90`);
  if (q.lon < -180 || q.lon > 180) throw new InputError(`${what}.lon must be between -180 and 180`);
  return { lat: q.lat, lon: q.lon };
}

/**
 * "1 camera", "2 cameras", "0 cameras".
 * @param {number} n
 */
function cameraCount(n) {
  return `${n} ${n === 1 ? 'camera' : 'cameras'}`;
}

/**
 * True when some point of the route lies outside the bbox.
 * @param {BBox} area
 * @param {Route} route
 */
function leavesArea(area, route) {
  return route.points.some((pt) => !bboxContains(area, { lat: pt[0], lon: pt[1] }));
}

/**
 * Merge a fresh fetch into the known cameras by id. A camera already known keeps its place in
 * the order but takes the fresh data; new ones are appended. Also drops duplicate ids within one
 * fetch, so a route never lists the same camera twice.
 * @param {Map<string, Camera>} known
 * @param {Camera[]} fetched
 */
function mergeCameras(known, fetched) {
  if (!Array.isArray(fetched)) return;
  for (const c of fetched) {
    if (c && c.id != null) known.set(String(c.id), c);
  }
}

// ---- public API ----

/**
 * Check and normalize a PlanRequest.
 * - start and end need finite lat in [-90, 90] and lon in [-180, 180], else InputError.
 * - bufferM defaults to DEFAULT_BUFFER_M; non-finite or outside [MIN_BUFFER_M, MAX_BUFFER_M] is InputError.
 * - straight-line start-end distance > MAX_TRIP_M is TripTooLongError.
 * Extra fields are dropped.
 * @param {unknown} req
 * @returns {{start: LatLng, end: LatLng, bufferM: number}}
 */
export function validatePlanRequest(req) {
  if (!req || typeof req !== 'object' || Array.isArray(req)) {
    throw new InputError('request must be an object {start, end, bufferM?}');
  }
  const r = /** @type {any} */ (req);
  const start = checkPoint(r.start, 'start');
  const end = checkPoint(r.end, 'end');

  let bufferM = DEFAULT_BUFFER_M;
  if (r.bufferM !== undefined) {
    if (!Number.isFinite(r.bufferM) || r.bufferM < MIN_BUFFER_M || r.bufferM > MAX_BUFFER_M) {
      throw new InputError(`bufferM must be a number from ${MIN_BUFFER_M} to ${MAX_BUFFER_M} meters`);
    }
    bufferM = r.bufferM;
  }

  const tripM = haversineM(start, end);
  if (tripM > MAX_TRIP_M) {
    throw new TripTooLongError(
      `start and end are ${(tripM / 1000).toFixed(1)} km apart in a straight line; ` +
        `the limit is ${MAX_TRIP_M / 1000} km`,
    );
  }
  return { start, end, bufferM };
}

// Builder's notes on the points the planRoutes JSDoc leaves open (decisions planner.*):
//  - "<n> camera(s)" is written with the real plural: "1 camera", "2 cameras".
//  - Both counts describe the avoiding route: the first note counts its unavoidable cameras,
//    the second its avoidable ones, so the two notes never count the same camera.
//  - An avoid call that fails with NoRouteError still counts in `iterations`.
//  - "Too many cameras..." also appears when the MAX_AVOID_ITERATIONS limit ends the search
//    while the latest candidate still passes an avoidable camera that is not yet blocked.
//  - Errors other than NoRouteError from an avoid call propagate unchanged, like the others.
//  - If every avoidable camera on a candidate is already blocked (the router ignored the avoid
//    list), calling again cannot help, so the search stops without a note.
//  - "Leaves area" means some route point is outside the area bbox.
//  - After the trip area grows, every candidate is re-counted against the full camera list.

/**
 * Algorithm (decision hub.7):
 *  1. validatePlanRequest(req).
 *  2. fastest = router.route({start, end, avoid: [], avoidRadiusM: bufferM}).
 *  3. area = bboxAround([start, end, ...fastest.points], CORRIDOR_MARGIN_M);
 *     cameras = cameraSource.getCameras(area).
 *  4. A camera is "unavoidable" if it is within bufferM of start or end; it is never put in avoid.
 *  5. blocked = []. Repeat up to MAX_AVOID_ITERATIONS times while the latest candidate passes
 *     an avoidable camera: add that candidate's avoidable cameras (in route order) to blocked,
 *     capped at router.maxAvoid; call router.route({start, end, avoid: blocked, avoidRadiusM: bufferM}).
 *     If the new route leaves `area`, grow area with bboxUnion(area, bboxAround(route.points,
 *     CORRIDOR_MARGIN_M)) and fetch cameras again before counting. Stop early on NoRouteError
 *     (add a note) or when the cap stops blocked from growing.
 *  6. avoiding = the candidate (fastest included) with the fewest cameras, ties to shorter durationS.
 *  7. notes, in this order when they apply:
 *     "<n> camera(s) next to your start or end can't be avoided."
 *     "The avoiding route still passes <n> camera(s)."
 *     "Too many cameras to block them all; showing the best route found."
 *     "No other route was found."
 * Errors from validatePlanRequest, the fastest route call and getCameras propagate unchanged.
 * Camera hits use camerasNearRoute(cameras, route.points, bufferM) from geo.js.
 * @param {PlanRequest} req
 * @param {{cameraSource: CameraSource, router: Router}} deps
 * @returns {Promise<RoutePlan>}
 */
export async function planRoutes(req, deps) {
  // 1.
  const { start, end, bufferM } = validatePlanRequest(req);
  const { cameraSource, router } = deps;
  /** @param {LatLng[]} avoid */
  const routeRequest = (avoid) => ({
    start: { lat: start.lat, lon: start.lon },
    end: { lat: end.lat, lon: end.lon },
    avoid,
    avoidRadiusM: bufferM,
  });

  // 2.
  const fastest = await router.route(routeRequest([]));

  // 3.
  let area = bboxAround([start, end, ...fastest.points], CORRIDOR_MARGIN_M);
  /** @type {Map<string, Camera>} */
  const known = new Map();
  mergeCameras(known, await cameraSource.getCameras(area));
  let cameras = [...known.values()];

  // 4.
  /** @param {Camera} c */
  const isUnavoidable = (c) => haversineM(c, start) <= bufferM || haversineM(c, end) <= bufferM;
  /** @param {Route} route */
  const hitsOf = (route) => camerasNearRoute(cameras, route.points, bufferM);

  // 5.
  const maxAvoid =
    typeof router.maxAvoid === 'number' && router.maxAvoid >= 0 ? Math.floor(router.maxAvoid) : Infinity;
  /** @type {Route[]} */
  const candidates = [fastest];
  /** @type {LatLng[]} */
  const blocked = [];
  const blockedIds = new Set();
  let iterations = 0;
  let tooMany = false;
  let noRoute = false;
  let latestHits = hitsOf(fastest);

  for (;;) {
    const avoidable = latestHits.filter((c) => !isUnavoidable(c));
    if (avoidable.length === 0) break; // clean apart from unavoidable cameras: done
    const fresh = avoidable.filter((c) => !blockedIds.has(String(c.id)));
    if (fresh.length === 0) break; // the router ignored the avoid list; asking again won't help
    if (iterations >= MAX_AVOID_ITERATIONS || blocked.length >= maxAvoid) {
      tooMany = true; // out of router calls, or the cap stops blocked from growing
      break;
    }
    for (const c of fresh) {
      if (blocked.length >= maxAvoid) break;
      blocked.push({ lat: c.lat, lon: c.lon });
      blockedIds.add(String(c.id));
    }

    iterations++;
    /** @type {Route} */
    let route;
    try {
      route = await router.route(routeRequest(blocked.map((p) => ({ lat: p.lat, lon: p.lon }))));
    } catch (err) {
      if (err instanceof NoRouteError) {
        noRoute = true;
        break;
      }
      throw err;
    }

    if (leavesArea(area, route)) {
      area = bboxUnion(area, bboxAround(route.points, CORRIDOR_MARGIN_M));
      mergeCameras(known, await cameraSource.getCameras(area));
      cameras = [...known.values()];
    }
    candidates.push(route);
    latestHits = hitsOf(route);
  }

  // 6. Count every candidate against the final camera list (it only grows).
  /** @type {RouteResult[]} */
  const results = candidates.map((route) => ({ route, cameraIds: hitsOf(route).map((c) => String(c.id)) }));
  let best = results[0];
  for (const r of results.slice(1)) {
    const fewer = r.cameraIds.length < best.cameraIds.length;
    const tieFaster = r.cameraIds.length === best.cameraIds.length && r.route.durationS < best.route.durationS;
    if (fewer || tieFaster) best = r;
  }

  // 7.
  /** @type {string[]} */
  const notes = [];
  let unavoidableCount = 0;
  for (const id of best.cameraIds) {
    const c = known.get(id);
    if (c && isUnavoidable(c)) unavoidableCount++;
  }
  const avoidableCount = best.cameraIds.length - unavoidableCount;
  if (unavoidableCount > 0) {
    notes.push(`${cameraCount(unavoidableCount)} next to your start or end can't be avoided.`);
  }
  if (avoidableCount > 0) {
    notes.push(`The avoiding route still passes ${cameraCount(avoidableCount)}.`);
  }
  if (tooMany) notes.push('Too many cameras to block them all; showing the best route found.');
  if (noRoute) notes.push('No other route was found.');

  return {
    fastest: results[0],
    avoiding: { route: best.route, cameraIds: best.cameraIds.slice() },
    cameras,
    bufferM,
    iterations,
    notes,
  };
}
