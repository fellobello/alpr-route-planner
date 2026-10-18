// @ts-check
/**
 * Pure browser helpers (no DOM, no Leaflet) so they can be tested with `node --test`.
 * INTERFACE FILE: exported names, signatures and exact output formats are fixed;
 * the web module's builder fills in bodies. public/app.js uses these.
 *
 * Shapes match src/types.js: LatLng {lat, lon}, PlanRequest, RoutePlan, ClientConfig.
 */

/** @typedef {{lat: number, lon: number}} LatLng */
/** @typedef {{start: LatLng|null, end: LatLng|null}} ClickState */

/**
 * Query value for GET /api/cameras: "south,west,north,east", each rounded to 5 decimals,
 * with no trailing zeros (uses Number(x.toFixed(5)) then String).
 * @param {{south: number, west: number, north: number, east: number}} bounds
 * @returns {string}
 */
export function bboxParam(bounds) {
  throw new Error('not implemented: web.bboxParam');
}

/**
 * Under 1000 m: "<rounded> m" (e.g. "850 m"). Otherwise km with one decimal: "3.4 km".
 * @param {number} meters
 * @returns {string}
 */
export function formatDistance(meters) {
  throw new Error('not implemented: web.formatDistance');
}

/**
 * Under 30 s: "<1 min". Otherwise m = Math.round(s / 60); under 60: "<m> min" (e.g. "12 min");
 * else "<h> h <rest> min" (e.g. "1 h 5 min").
 * @param {number} seconds
 * @returns {string}
 */
export function formatDuration(seconds) {
  throw new Error('not implemented: web.formatDuration');
}

/**
 * Click cycle on the map: no start -> set start; start but no end -> set end;
 * both set -> new start, end cleared. Returns a new object.
 * @param {ClickState} state
 * @param {LatLng} point
 * @returns {ClickState}
 */
export function nextClickState(state, point) {
  throw new Error('not implemented: web.nextClickState');
}

/**
 * Body for POST /api/route: {start: {lat, lon}, end: {lat, lon}, bufferM}. Copies only lat/lon.
 * @param {LatLng} start
 * @param {LatLng} end
 * @param {number} bufferM
 * @returns {{start: LatLng, end: LatLng, bufferM: number}}
 */
export function buildRouteRequest(start, end, bufferM) {
  throw new Error('not implemented: web.buildRouteRequest');
}

/**
 * Text for the results panel.
 * cameraText: "No cameras" | "1 camera" | "<n> cameras".
 * extraText (avoiding only): d = avoiding.durationS - fastest.durationS;
 *   d < 30 -> "no extra time", else "+" + formatDuration(d).
 * same: true when both routes have identical points.
 * @param {any} plan  a RoutePlan from POST /api/route
 * @returns {{
 *   fastest: {distanceText: string, durationText: string, cameraCount: number, cameraText: string},
 *   avoiding: {distanceText: string, durationText: string, cameraCount: number, cameraText: string, extraText: string},
 *   same: boolean,
 *   notes: string[]
 * }}
 */
export function summarizePlan(plan) {
  throw new Error('not implemented: web.summarizePlan');
}
