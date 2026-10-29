// @ts-check
/**
 * The API's behavior with no HTTP in it, so the same code answers requests in the Node server
 * (src/server/app.js) and inside the Android app's WebView (mobile/web/transport.js).
 * Each method resolves to the JSON body of a 200 response or throws one of the shared errors;
 * errorStatus maps those to HTTP statuses.
 */
import {
  APP_TITLE,
  APP_VERSION,
  DEFAULT_BUFFER_M,
  DEFAULT_CENTER,
  DEFAULT_ZOOM,
  InputError,
  MAX_BBOX_SPAN_DEG,
  MAX_BUFFER_M,
  MAX_QUERY_CHARS,
  MAX_TRIP_M,
  MIN_BUFFER_M,
  MIN_CAMERA_ZOOM,
  NoRouteError,
  TripTooLongError,
  UpstreamError,
} from './types.js';
import { planRoutes as defaultPlanRoutes } from './planner.js';
import { coordinatePlace, parseCoordinates } from './geocode/coordinates.js';

/** @typedef {import('./types.js').BBox} BBox */
/** @typedef {import('./types.js').CameraSource} CameraSource */
/** @typedef {import('./types.js').Router} Router */
/** @typedef {import('./types.js').Geocoder} Geocoder */
/** @typedef {import('./types.js').PlanRequest} PlanRequest */
/** @typedef {import('./types.js').RoutePlan} RoutePlan */
/** @typedef {import('./types.js').ClientConfig} ClientConfig */

/** Rounding slack for the bbox span check, so a client's 0.5-degree box is not refused over 1e-15. */
const SPAN_EPSILON_DEG = 1e-9;

/** A plain decimal number: optional sign, digits with optional fraction, optional exponent. */
const DECIMAL_RE = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/;

/**
 * Parse "south,west,north,east" (decimal degrees). Throws InputError when it is not exactly
 * four finite numbers, south > north, west > east, out of range, or either span exceeds
 * MAX_BBOX_SPAN_DEG.
 * @param {string|null|undefined} text
 * @returns {BBox}
 */
export function parseBbox(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new InputError('bbox is required as south,west,north,east');
  }
  const parts = text.split(',').map((p) => p.trim());
  if (parts.length !== 4) {
    throw new InputError(`bbox must have 4 numbers (south,west,north,east), got ${parts.length}`);
  }
  const nums = parts.map((p) => (DECIMAL_RE.test(p) ? Number(p) : NaN));
  if (!nums.every(Number.isFinite)) {
    throw new InputError('bbox must be 4 decimal numbers: south,west,north,east');
  }
  const [south, west, north, east] = nums;
  if (south < -90 || south > 90 || north < -90 || north > 90) {
    throw new InputError('bbox latitudes must be between -90 and 90');
  }
  if (west < -180 || west > 180 || east < -180 || east > 180) {
    throw new InputError('bbox longitudes must be between -180 and 180');
  }
  if (south > north) throw new InputError('bbox south must not be greater than north');
  if (west > east) throw new InputError('bbox west must not be greater than east');
  if (north - south > MAX_BBOX_SPAN_DEG + SPAN_EPSILON_DEG || east - west > MAX_BBOX_SPAN_DEG + SPAN_EPSILON_DEG) {
    throw new InputError(`bbox is too large: each side may span at most ${MAX_BBOX_SPAN_DEG} degrees; zoom in`);
  }
  return { south, west, north, east };
}

/**
 * HTTP status for an error thrown by a handler: TripTooLongError 422, InputError 400,
 * NoRouteError 422, UpstreamError 502, anything else 500.
 * @param {unknown} err
 * @returns {number}
 */
export function errorStatus(err) {
  // TripTooLongError extends InputError, so it must be checked first.
  if (err instanceof TripTooLongError) return 422;
  if (err instanceof InputError) return 400;
  if (err instanceof NoRouteError) return 422;
  if (err instanceof UpstreamError) return 502;
  return 500;
}

/**
 * The optional "near=lat,lon" bias for a search; null when absent or unreadable (it is only a hint).
 * @param {string|null|undefined} text
 */
function parseNear(text) {
  return typeof text === 'string' ? parseCoordinates(text) : null;
}

/**
 * @param {Object} deps
 * @param {CameraSource} deps.cameraSource
 * @param {Router} deps.router
 * @param {Geocoder|null} [deps.geocoder]  without one, search only understands typed coordinates
 * @param {(req: PlanRequest, deps: {cameraSource: CameraSource, router: Router}) => Promise<RoutePlan>} [deps.planRoutes]
 */
export function createApi(deps) {
  const { cameraSource, router } = deps;
  const geocoder = deps.geocoder ?? null;
  const plan = deps.planRoutes ?? defaultPlanRoutes;

  return {
    health: async () => ({ ok: true, cameraSource: cameraSource.name, router: router.name }),

    /** @returns {Promise<ClientConfig>} */
    config: async () => ({
      center: { lat: DEFAULT_CENTER.lat, lon: DEFAULT_CENTER.lon },
      zoom: DEFAULT_ZOOM,
      minCameraZoom: MIN_CAMERA_ZOOM,
      defaultBufferM: DEFAULT_BUFFER_M,
      minBufferM: MIN_BUFFER_M,
      maxBufferM: MAX_BUFFER_M,
      maxTripM: MAX_TRIP_M,
      maxBboxSpanDeg: MAX_BBOX_SPAN_DEG,
      cameraSource: cameraSource.name,
      router: router.name,
      geocoder: geocoder ? geocoder.name : 'coordinates',
      appTitle: APP_TITLE,
      version: APP_VERSION,
    }),

    /** @param {string|null|undefined} bboxText */
    cameras: async (bboxText) => {
      const bbox = parseBbox(bboxText);
      const cameras = await cameraSource.getCameras(bbox);
      return { cameras, source: cameraSource.name };
    },

    /** @param {unknown} body  parsed JSON object */
    route: async (body) => plan(/** @type {PlanRequest} */ (body), { cameraSource, router }),

    /**
     * @param {string|null|undefined} q
     * @param {string|null|undefined} nearText
     */
    geocode: async (q, nearText) => {
      const query = typeof q === 'string' ? q.trim() : '';
      if (!query) throw new InputError('q is required: an address, place name or "lat, lon"');
      if (query.length > MAX_QUERY_CHARS) throw new InputError(`q may be at most ${MAX_QUERY_CHARS} characters`);
      const typed = parseCoordinates(query);
      if (typed) return { results: [coordinatePlace(typed)] };
      const results = geocoder ? await geocoder.search(query, parseNear(nearText)) : [];
      return { results };
    },
  };
}
