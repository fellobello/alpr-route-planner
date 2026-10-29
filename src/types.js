// @ts-check
/**
 * Shared types, constants and error classes. INTERFACE FILE: builders must not change it.
 *
 * Coordinate conventions used everywhere in this project:
 *   - a single point is an object  {lat, lon}            (LatLng)
 *   - a line is an array of pairs  [[lat, lon], ...]     (LatLonPair[], Leaflet order)
 *   - only Valhalla polygons / GeoJSON use [lon, lat], and that stays inside src/routing/.
 * Distances are meters, durations are seconds.
 */

/** @typedef {{lat: number, lon: number}} LatLng */

/** @typedef {[number, number]} LatLonPair  A point as [lat, lon]. */

/** @typedef {{south: number, west: number, north: number, east: number}} BBox */

/**
 * One license plate reader camera.
 * @typedef {Object} Camera
 * @property {string} id                 Stable id: "osm:node/<osm id>" for OSM data, "sample:<n>" for the bundled sample file.
 * @property {number} lat
 * @property {number} lon
 * @property {boolean} isFlock           true when the manufacturer or brand tag contains "flock" (case-insensitive).
 * @property {string|null} manufacturer  OSM manufacturer tag, or null.
 * @property {string|null} operator      OSM operator tag, or null.
 * @property {number|null} direction     Degrees clockwise from north (first value if several), or null when absent or unparseable.
 * @property {"osm"|"sample"} source
 */

/**
 * A drivable path returned by a Router.
 * @typedef {Object} Route
 * @property {LatLonPair[]} points  At least 2 points, first near start, last near end.
 * @property {number} distanceM
 * @property {number} durationS
 */

/**
 * @typedef {Object} RouteRequest
 * @property {LatLng} start
 * @property {LatLng} end
 * @property {LatLng[]} avoid         Points (cameras) whose roads the route must not use. May be empty. Length <= router.maxAvoid.
 * @property {number} avoidRadiusM    How far around each avoid point to block, in meters.
 */

/**
 * Where camera locations come from. Implementations: OverpassCameraSource, FixtureCameraSource.
 * getCameras resolves to every known camera inside the bbox (inclusive), each id at most once.
 * It rejects with UpstreamError when the data service fails.
 * @typedef {Object} CameraSource
 * @property {string} name                               "overpass" | "fixture"
 * @property {(bbox: BBox) => Promise<Camera[]>} getCameras
 */

/**
 * Turn-by-turn routing engine. Implementations: ValhallaRouter, StubRouter.
 * route rejects with NoRouteError when no path exists, UpstreamError when the service fails,
 * InputError when avoid.length > maxAvoid.
 * @typedef {Object} Router
 * @property {string} name                               "valhalla" | "stub"
 * @property {number} maxAvoid                           Max avoid points accepted per request.
 * @property {(req: RouteRequest) => Promise<Route>} route
 */

/**
 * Body of POST /api/route and input of planRoutes.
 * @typedef {Object} PlanRequest
 * @property {LatLng} start
 * @property {LatLng} end
 * @property {number} [bufferM]   Defaults to DEFAULT_BUFFER_M. Must be within [MIN_BUFFER_M, MAX_BUFFER_M].
 */

/**
 * @typedef {Object} RouteResult
 * @property {Route} route
 * @property {string[]} cameraIds   Ids of cameras within bufferM of route.points, ordered by position along the route.
 */

/**
 * Response of POST /api/route and output of planRoutes.
 * @typedef {Object} RoutePlan
 * @property {RouteResult} fastest     The route with no avoidance.
 * @property {RouteResult} avoiding    The candidate with the fewest cameras (ties: shorter duration). Deep-equals fastest when fastest has no cameras.
 * @property {Camera[]} cameras        Every camera fetched for the trip area (so the map can draw them).
 * @property {number} bufferM          The buffer actually used.
 * @property {number} iterations       Router calls made looking for the avoiding route (0 when none were needed).
 * @property {string[]} notes          Plain-English notes for the user, e.g. "1 camera is next to your start and can't be avoided".
 */

/**
 * Response of GET /api/config, used by the browser so defaults live in one place.
 * @typedef {Object} ClientConfig
 * @property {LatLng} center
 * @property {number} zoom
 * @property {number} minCameraZoom
 * @property {number} defaultBufferM
 * @property {number} minBufferM
 * @property {number} maxBufferM
 * @property {number} maxTripM
 * @property {number} maxBboxSpanDeg
 * @property {string} cameraSource     name of the active CameraSource
 * @property {string} router           name of the active Router
 * @property {string} appTitle
 */

// ---- Constants (decisions recorded in .hub/questions) ----

export const APP_TITLE = 'ALPR Route Planner';
export const DEFAULT_BUFFER_M = 75;
export const MIN_BUFFER_M = 15;
export const MAX_BUFFER_M = 300;
/** Max straight-line distance between start and end. */
export const MAX_TRIP_M = 50_000;
/** Margin added around the route when fetching cameras for a trip. */
export const CORRIDOR_MARGIN_M = 2_000;
/** Max router calls when searching for the avoiding route. */
export const MAX_AVOID_ITERATIONS = 4;
/** Max width or height of a bbox accepted by GET /api/cameras, in degrees. */
export const MAX_BBOX_SPAN_DEG = 0.5;
/** Default map view: San Luis Obispo, CA. */
export const DEFAULT_CENTER = Object.freeze({ lat: 35.2828, lon: -120.6596 });
export const DEFAULT_ZOOM = 13;
/** The map only loads cameras at this zoom or closer. */
export const MIN_CAMERA_ZOOM = 12;
/** Camera cache lifetime for OverpassCameraSource. */
export const CAMERA_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
/**
 * User-Agent sent to Overpass and Valhalla (their usage policies ask for an identifying one).
 * Set CONTACT to an email or URL to include it.
 */
export const USER_AGENT = `alpr-route-planner/0.1 (${process.env.CONTACT || 'local sample build'})`;

// ---- Errors. `code` is what the API puts in {error, code}. ----

/** Bad input from the caller. HTTP 400. */
export class InputError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'InputError';
    /** @type {string} */
    this.code = 'INPUT';
  }
}

/** Start and end are farther apart than MAX_TRIP_M. HTTP 422. */
export class TripTooLongError extends InputError {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'TripTooLongError';
    this.code = 'TRIP_TOO_LONG';
  }
}

/** The router found no path between the points. HTTP 422. */
export class NoRouteError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'NoRouteError';
    this.code = 'NO_ROUTE';
  }
}

/** An outside service (Overpass, Valhalla) failed or returned junk. HTTP 502. */
export class UpstreamError extends Error {
  /**
   * @param {string} service  "overpass" | "valhalla"
   * @param {string} message
   */
  constructor(service, message) {
    super(`${service}: ${message}`);
    this.name = 'UpstreamError';
    this.code = 'UPSTREAM';
    this.service = service;
  }
}

/** Thrown by interface stubs until a builder implements them. */
export class NotImplementedError extends Error {
  /** @param {string} what */
  constructor(what) {
    super(`not implemented: ${what}`);
    this.name = 'NotImplementedError';
  }
}
