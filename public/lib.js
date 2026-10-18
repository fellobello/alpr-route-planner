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
  return [bounds.south, bounds.west, bounds.north, bounds.east]
    .map((x) => String(Number(x.toFixed(5))))
    .join(',');
}

/**
 * Under 1000 m: "<rounded> m" (e.g. "850 m"). Otherwise km with one decimal: "3.4 km".
 * @param {number} meters
 * @returns {string}
 */
export function formatDistance(meters) {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

/**
 * Under 30 s: "<1 min". Otherwise m = Math.round(s / 60); under 60: "<m> min" (e.g. "12 min");
 * else "<h> h <rest> min" (e.g. "1 h 5 min").
 * @param {number} seconds
 * @returns {string}
 */
export function formatDuration(seconds) {
  if (seconds < 30) return '<1 min';
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/**
 * Click cycle on the map: no start -> set start; start but no end -> set end;
 * both set -> new start, end cleared. Returns a new object.
 * @param {ClickState} state
 * @param {LatLng} point
 * @returns {ClickState}
 */
export function nextClickState(state, point) {
  if (!state.start) return { start: point, end: state.end ?? null };
  if (!state.end) return { start: state.start, end: point };
  return { start: point, end: null };
}

/**
 * Body for POST /api/route: {start: {lat, lon}, end: {lat, lon}, bufferM}. Copies only lat/lon.
 * @param {LatLng} start
 * @param {LatLng} end
 * @param {number} bufferM
 * @returns {{start: LatLng, end: LatLng, bufferM: number}}
 */
export function buildRouteRequest(start, end, bufferM) {
  return {
    start: { lat: start.lat, lon: start.lon },
    end: { lat: end.lat, lon: end.lon },
    bufferM,
  };
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
  const fastest = routeSummary(plan.fastest);
  const avoiding = routeSummary(plan.avoiding);
  const d = plan.avoiding.route.durationS - plan.fastest.route.durationS;
  return {
    fastest,
    avoiding: { ...avoiding, extraText: d < 30 ? 'no extra time' : '+' + formatDuration(d) },
    same: samePoints(plan.fastest.route.points, plan.avoiding.route.points),
    notes: Array.isArray(plan.notes) ? plan.notes.slice() : [],
  };
}

/**
 * @param {number} n
 * @returns {string}
 */
function cameraText(n) {
  if (n === 0) return 'No cameras';
  if (n === 1) return '1 camera';
  return `${n} cameras`;
}

/**
 * @param {{route: {distanceM: number, durationS: number}, cameraIds: string[]}} result
 */
function routeSummary(result) {
  const cameraCount = result.cameraIds.length;
  return {
    distanceText: formatDistance(result.route.distanceM),
    durationText: formatDuration(result.route.durationS),
    cameraCount,
    cameraText: cameraText(cameraCount),
  };
}

/**
 * @param {number[][]} a
 * @param {number[][]} b
 * @returns {boolean}
 */
function samePoints(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].length !== b[i].length) return false;
    for (let j = 0; j < a[i].length; j++) {
      if (a[i][j] !== b[i][j]) return false;
    }
  }
  return true;
}
