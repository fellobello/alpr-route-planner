// @ts-check
/**
 * Offline router that needs no network. Not real roads: it draws straight lines and dog-legs
 * so the app and planner can be demoed and tested without Valhalla.
 * INTERFACE FILE: exported names, signatures and documented behavior are fixed.
 */
import { NotImplementedError } from '../types.js';

/** @typedef {import('../types.js').Route} Route */
/** @typedef {import('../types.js').RouteRequest} RouteRequest */
/** @typedef {import('../types.js').Router} Router */

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
    throw new NotImplementedError('routing.StubRouter.route');
  }
}
