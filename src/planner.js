// @ts-check
/**
 * Plans a fastest route and a camera-avoiding route. INTERFACE FILE: exported names, signatures
 * and documented behavior are fixed; the planner module's builder fills in bodies.
 * Talks only to the CameraSource and Router it is given, so it works with real or fake ones.
 */
import { NotImplementedError } from './types.js';

/** @typedef {import('./types.js').LatLng} LatLng */
/** @typedef {import('./types.js').PlanRequest} PlanRequest */
/** @typedef {import('./types.js').RoutePlan} RoutePlan */
/** @typedef {import('./types.js').CameraSource} CameraSource */
/** @typedef {import('./types.js').Router} Router */

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
  throw new NotImplementedError('planner.validatePlanRequest');
}

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
  throw new NotImplementedError('planner.planRoutes');
}
