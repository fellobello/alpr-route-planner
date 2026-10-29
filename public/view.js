// @ts-check
/**
 * Pure view helpers for app.js (no DOM, no Leaflet), kept apart from the fixed interface in
 * lib.js so they can be tested with `node --test`.
 */

/** @typedef {{lat: number, lon: number}} LatLng */
/** @typedef {{south: number, west: number, north: number, east: number}} Bounds */
/**
 * @typedef {Object} Camera
 * @property {string} id
 * @property {number} lat
 * @property {number} lon
 * @property {boolean} isFlock
 * @property {string|null} manufacturer
 * @property {string|null} operator
 */

/** Map colors; style.css repeats them for the legend. */
export const COLORS = Object.freeze({
  flock: '#e11d48',
  otherAlpr: '#f59e0b',
  hitOutline: '#111827',
  fastest: '#64748b',
  avoiding: '#2563eb',
});

/**
 * Bounds to ask GET /api/cameras for. Latitudes are clamped to [-90, 90] and longitudes to
 * [-180, 180] (Leaflet reports wrapped longitudes past 180 when the world repeats). A side
 * wider than maxSpanDeg is shrunk around its center to just under maxSpanDeg, so that the
 * 5-decimal rounding in bboxParam cannot push it over the server's limit.
 * @param {Bounds} bounds
 * @param {number} maxSpanDeg
 * @returns {{bounds: Bounds, clipped: boolean}}
 */
export function clampBounds(bounds, maxSpanDeg) {
  let south = clamp(bounds.south, -90, 90);
  let north = clamp(bounds.north, -90, 90);
  let west = clamp(bounds.west, -180, 180);
  let east = clamp(bounds.east, -180, 180);
  const limit = maxSpanDeg * 0.98;
  let clipped = false;
  if (north - south > maxSpanDeg) {
    const mid = (north + south) / 2;
    south = mid - limit / 2;
    north = mid + limit / 2;
    clipped = true;
  }
  if (east - west > maxSpanDeg) {
    const mid = (east + west) / 2;
    west = mid - limit / 2;
    east = mid + limit / 2;
    clipped = true;
  }
  return { bounds: { south, west, north, east }, clipped };
}

/**
 * @param {number} x
 * @param {number} lo
 * @param {number} hi
 */
function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

/**
 * Every camera once, by id; the first list wins for duplicate ids.
 * @param {...(Camera[]|null|undefined)} lists
 * @returns {Camera[]}
 */
export function mergeCameras(...lists) {
  /** @type {Map<string, Camera>} */
  const byId = new Map();
  for (const list of lists) {
    for (const cam of list || []) {
      if (!byId.has(cam.id)) byId.set(cam.id, cam);
    }
  }
  return [...byId.values()];
}

/**
 * Which planned routes pass a camera.
 * @param {string} id
 * @param {{fastest: Set<string>, avoiding: Set<string>}} hits
 * @returns {{fastest: boolean, avoiding: boolean}}
 */
export function cameraHits(id, hits) {
  return { fastest: hits.fastest.has(id), avoiding: hits.avoiding.has(id) };
}

/**
 * Leaflet circleMarker options: one color for Flock, one for other ALPRs; cameras next to a
 * planned route get a larger marker with a dark outline.
 * @param {Camera} camera
 * @param {{fastest: boolean, avoiding: boolean}} hit
 */
export function cameraStyle(camera, hit) {
  const fill = camera.isFlock ? COLORS.flock : COLORS.otherAlpr;
  const isHit = hit.fastest || hit.avoiding;
  return {
    radius: isHit ? 9 : 6,
    color: isHit ? COLORS.hitOutline : '#ffffff',
    weight: isHit ? 3 : 1.5,
    fillColor: fill,
    fillOpacity: 0.85,
  };
}

/**
 * Popup content for a camera as plain text: a heading and label/value rows.
 * @param {Camera} camera
 * @param {{fastest: boolean, avoiding: boolean}} hit
 * @returns {{title: string, rows: [string, string][]}}
 */
export function cameraPopup(camera, hit) {
  /** @type {[string, string][]} */
  const rows = [
    ['Manufacturer', camera.manufacturer || 'unknown'],
    ['Operator', camera.operator || 'unknown'],
  ];
  const on = [];
  if (hit.fastest) on.push('fastest');
  if (hit.avoiding) on.push('avoiding');
  if (on.length) rows.push(['Next to', on.join(' and ') + (on.length > 1 ? ' routes' : ' route')]);
  return { title: camera.isFlock ? 'Flock ALPR camera' : 'ALPR camera', rows };
}

/** What to tell people when an outside service fails, instead of its raw error. */
const UPSTREAM_HELP = /** @type {Record<string, string>} */ ({
  overpass: 'The OpenStreetMap camera service is busy or down. Try again in a minute.',
  valhalla: 'The routing service is busy or down. Try again in a minute.',
  nominatim: 'Place search is busy or down. Try again, or click the map.',
});

/**
 * Message for a failed API call: the server's {error} when it sent one.
 * @param {number} status
 * @param {unknown} body  parsed JSON body, or null
 * @returns {string}
 */
export function errorMessage(status, body) {
  if (body && typeof body === 'object' && typeof (/** @type {any} */ (body).error) === 'string') {
    const msg = /** @type {any} */ (body).error.trim();
    const service = /** @type {any} */ (body).code === 'UPSTREAM' ? msg.split(':')[0] : '';
    if (Object.hasOwn(UPSTREAM_HELP, service)) return UPSTREAM_HELP[service];
    if (msg) return msg;
  }
  return `Request failed (HTTP ${status}).`;
}

/**
 * Status line under the camera legend.
 * @param {{zoom: number, minZoom: number, loading: boolean, count: number|null, clipped: boolean, error: string|null}} s
 * @returns {string}
 */
export function cameraStatus(s) {
  if (s.zoom < s.minZoom) return 'Zoom in to see cameras.';
  if (s.error) return `Could not load cameras: ${s.error}`;
  if (s.loading || s.count === null) return 'Loading cameras...';
  const n = s.count === 1 ? '1 camera' : `${s.count} cameras`;
  return s.clipped ? `${n} near the center of the view (zoom in to see the edges).` : `${n} in view.`;
}

/**
 * Hint above the Plan route button for the current click state.
 * @param {{start: LatLng|null, end: LatLng|null}} state
 * @returns {string}
 */
export function clickHint(state) {
  if (!state.start) return 'Search for a place, or click the map, to set the start.';
  if (!state.end) return 'Now set the destination.';
  return 'Ready to plan. Clicking the map again starts over.';
}

/**
 * One sentence comparing the two routes, for the top of the results.
 * @param {{fastest: {cameraCount: number}, avoiding: {cameraCount: number, extraText: string}, same: boolean}} s
 *        a summarizePlan result
 * @returns {string}
 */
export function planVerdict(s) {
  const f = s.fastest.cameraCount;
  const a = s.avoiding.cameraCount;
  if (s.same) return f === 0 ? 'The fastest route passes no mapped cameras.' : 'No route found that passes fewer mapped cameras.';
  const avoided = f - a;
  const cams = avoided === 1 ? '1 camera' : `${avoided} cameras`;
  const cost = s.avoiding.extraText === 'no extra time' ? 'at no extra time' : `for ${s.avoiding.extraText.slice(1)} more`;
  return a === 0 ? `Avoids all ${cams} ${cost}.` : `Avoids ${cams} of ${f} ${cost}.`;
}

/**
 * Text for a point in the start or destination field: its place name, else its coordinates.
 * @param {LatLng|null} p
 * @param {string|null} [name]
 * @returns {string}
 */
export function pointLabel(p, name) {
  if (!p) return '';
  return name || `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`;
}

/**
 * Slider step: 5 m when every limit is a multiple of 5, else 1 m.
 * @param {{minBufferM: number, maxBufferM: number, defaultBufferM: number}} config
 * @returns {number}
 */
export function sliderStep(config) {
  const all = [config.minBufferM, config.maxBufferM, config.defaultBufferM];
  return all.every((v) => v % 5 === 0) ? 5 : 1;
}
