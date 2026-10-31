// @ts-check
/**
 * Browser app: Leaflet map with OSM tiles, ALPR camera markers, start/destination from place
 * search, the map or the device's location, and fastest vs camera-avoiding routes from the API.
 * Pure logic lives in lib.js (fixed interface) and view.js; transport.js reaches the API;
 * this file is the DOM and Leaflet glue.
 */
import { bboxParam, buildRouteRequest, nextClickState, summarizePlan } from './lib.js';
import {
  COLORS,
  cameraHits,
  cameraPopup,
  cameraStatus,
  cameraStyle,
  clampBounds,
  clickHint,
  errorMessage,
  mergeCameras,
  planVerdict,
  pointLabel,
  sliderStep,
} from './view.js';
import { apiFetch } from './transport.js';

/** @type {any} */
const L = /** @type {any} */ (window).L;

/** Used only when GET /api/config fails, so the map still opens. Same values as src/types.js. */
const FALLBACK_CONFIG = {
  center: { lat: 35.2828, lon: -120.6596 },
  zoom: 13,
  minCameraZoom: 12,
  defaultBufferM: 75,
  minBufferM: 15,
  maxBufferM: 300,
  maxTripM: 50000,
  maxBboxSpanDeg: 0.5,
  cameraSource: 'unknown',
  router: 'unknown',
  geocoder: 'coordinates',
  appTitle: 'ALPR Route Planner',
  version: '',
};

const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>';

/** Zoom used when jumping to a searched place or the device's location. */
const PLACE_ZOOM = 15;
/** Below this width the panel is a bottom sheet (matches style.css). */
const PHONE_WIDTH = 760;
const PREFS_KEY = 'alpr-route-planner:prefs';

/** @param {string} id */
function $(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}

const ui = {
  panel: $('panel'),
  sheetHandle: $('sheet-handle'),
  hint: $('hint'),
  startForm: $('start-form'),
  endForm: $('end-form'),
  startInput: /** @type {HTMLInputElement} */ ($('start-input')),
  endInput: /** @type {HTMLInputElement} */ ($('end-input')),
  startText: $('start-text'),
  endText: $('end-text'),
  startResults: $('start-results'),
  endResults: $('end-results'),
  startLocate: /** @type {HTMLButtonElement} */ ($('start-locate')),
  locate: /** @type {HTMLButtonElement} */ ($('locate')),
  swap: /** @type {HTMLButtonElement} */ ($('swap')),
  buffer: /** @type {HTMLInputElement} */ ($('buffer')),
  bufferValue: $('buffer-value'),
  plan: /** @type {HTMLButtonElement} */ ($('plan')),
  clear: /** @type {HTMLButtonElement} */ ($('clear')),
  error: $('error'),
  results: $('results'),
  resultsBody: $('results-body'),
  stale: $('stale'),
  cameraStatus: $('camera-status'),
  sourceNote: $('source-note'),
  examples: $('examples'),
  version: $('version'),
};

/** @typedef {'start'|'end'} Slot */
/** @typedef {{lat: number, lon: number}} LatLng */

const state = {
  config: FALLBACK_CONFIG,
  /** @type {{start: LatLng|null, end: LatLng|null}} */
  click: { start: null, end: null },
  /** Place names for the points, when they came from a search. @type {{start: string|null, end: string|null}} */
  names: { start: null, end: null },
  /** Bumped per search so a slow answer for an old query is dropped. */
  searchSeq: { start: 0, end: 0 },
  /** Cameras from the latest GET /api/cameras for the view. @type {any[]} */
  viewCameras: [],
  /** @type {{loading: boolean, count: number|null, clipped: boolean, error: string|null}} */
  cameraLoad: { loading: false, count: null, clipped: false, error: null },
  /** @type {AbortController|null} */
  cameraAbort: null,
  /** Latest RoutePlan, or null. @type {any} */
  plan: null,
  planBufferM: /** @type {number|null} */ (null),
  hits: { fastest: new Set(), avoiding: new Set() },
  planning: false,
  popupOpen: false,
  ignoreNextClick: false,
};

/**
 * API call + JSON with the API's {error} messages.
 * @param {string} url
 * @param {RequestInit} [options]
 * @returns {Promise<{ok: true, body: any} | {ok: false, aborted?: boolean, message: string}>}
 */
async function getJson(url, options) {
  let res;
  try {
    res = await apiFetch(url, options);
  } catch (err) {
    if (err && /** @type {any} */ (err).name === 'AbortError') return { ok: false, aborted: true, message: '' };
    return { ok: false, message: 'Could not reach the server. Check your connection.' };
  }
  let body = null;
  try {
    body = await res.json();
  } catch (err) {
    if (err && /** @type {any} */ (err).name === 'AbortError') return { ok: false, aborted: true, message: '' };
    body = null;
  }
  if (!res.ok) return { ok: false, message: errorMessage(res.status, body) };
  if (body === null) return { ok: false, message: 'The server sent a response that is not JSON.' };
  return { ok: true, body };
}

/** @param {string|null} message */
function showError(message) {
  ui.error.textContent = message || '';
  ui.error.hidden = !message;
}

/** Small saved settings (slider, last view). Storage can be missing or blocked; then nothing is kept. */
const prefs = {
  /** @returns {{bufferM?: number, view?: {lat: number, lon: number, zoom: number}}} */
  read() {
    try {
      return JSON.parse(globalThis.localStorage?.getItem(PREFS_KEY) || '{}') || {};
    } catch {
      return {};
    }
  },
  /** @param {object} patch */
  write(patch) {
    try {
      globalThis.localStorage?.setItem(PREFS_KEY, JSON.stringify({ ...prefs.read(), ...patch }));
    } catch {
      // private mode or storage full: settings just are not remembered
    }
  },
};

if (!L) {
  showError('Could not load the map. Reload the page to try again.');
  throw new Error('Leaflet not loaded');
}

// ---- Map ----

const map = L.map('map', { preferCanvas: true, zoomControl: false });
L.control.zoom({ position: 'topright' }).addTo(map);
// Routes under cameras. Each pane gets its own canvas, and a canvas takes every click on it, so
// cameras must be the top canvas; start/end are DOM markers in Leaflet's marker pane instead.
for (const [name, z] of [['routes', 410], ['cameras', 420]]) {
  map.createPane(name).style.zIndex = String(z);
}
L.tileLayer(TILE_URL, { maxZoom: 19, attribution: TILE_ATTRIBUTION }).addTo(map);

const routeLayer = L.layerGroup().addTo(map);
const cameraLayer = L.layerGroup().addTo(map);
const endpointLayer = L.layerGroup().addTo(map);
const myLocationLayer = L.layerGroup().addTo(map);
/** id -> {marker, key} so markers (and open popups) survive pans. @type {Map<string, {marker: any, key: string}>} */
const markers = new Map();

function isPhone() {
  return (globalThis.innerWidth ?? Infinity) <= PHONE_WIDTH;
}

/** Room the panel takes over the map, so fitted routes are not hidden under it. */
function fitPadding() {
  if (isPhone()) return { paddingTopLeft: [30, 60], paddingBottomRight: [30, (ui.panel.offsetHeight || 0) + 20] };
  return { paddingTopLeft: [(ui.panel.offsetWidth || 0) + 48, 40], paddingBottomRight: [40, 40] };
}

/** @param {LatLng} p */
function showPoint(p) {
  map.setView([p.lat, p.lon], Math.max(map.getZoom() ?? 0, PLACE_ZOOM));
}

// ---- Cameras ----

async function loadCameras() {
  const config = state.config;
  if (state.cameraAbort) state.cameraAbort.abort();
  state.cameraAbort = null;

  if (map.getZoom() < config.minCameraZoom) {
    state.viewCameras = [];
    state.cameraLoad = { loading: false, count: null, clipped: false, error: null };
    renderCameras();
    return;
  }

  const b = map.getBounds();
  const { bounds, clipped } = clampBounds(
    { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() },
    config.maxBboxSpanDeg,
  );
  const ctrl = new AbortController();
  state.cameraAbort = ctrl;
  state.cameraLoad = { ...state.cameraLoad, loading: true, error: null };
  renderCameraStatus();

  const res = await getJson(`/api/cameras?bbox=${bboxParam(bounds)}`, { signal: ctrl.signal });
  if (state.cameraAbort !== ctrl) return; // a newer request replaced this one
  state.cameraAbort = null;
  if (res.ok) {
    state.viewCameras = Array.isArray(res.body.cameras) ? res.body.cameras : [];
    state.cameraLoad = { loading: false, count: state.viewCameras.length, clipped, error: null };
  } else if (!res.aborted) {
    state.cameraLoad = { loading: false, count: null, clipped, error: res.message };
  }
  renderCameras();
}

function renderCameraStatus() {
  ui.cameraStatus.textContent = cameraStatus({
    zoom: map.getZoom(),
    minZoom: state.config.minCameraZoom,
    ...state.cameraLoad,
  });
}

/** Cameras in view (zoomed in), plus the plan's cameras; zoomed out, only cameras on a route. */
function renderCameras() {
  const planCameras = state.plan && Array.isArray(state.plan.cameras) ? state.plan.cameras : [];
  const zoomedIn = map.getZoom() >= state.config.minCameraZoom;
  const list = zoomedIn
    ? mergeCameras(state.viewCameras, planCameras)
    : planCameras.filter((c) => state.hits.fastest.has(c.id) || state.hits.avoiding.has(c.id));

  const keep = new Set();
  for (const cam of list) {
    keep.add(cam.id);
    const hit = cameraHits(cam.id, state.hits);
    const style = cameraStyle(cam, hit);
    const key = `${cam.isFlock}|${hit.fastest}|${hit.avoiding}`;
    const entry = markers.get(cam.id);
    if (!entry) {
      const marker = L.circleMarker([cam.lat, cam.lon], {
        ...style,
        pane: 'cameras',
        bubblingMouseEvents: false,
      });
      marker.bindPopup(() => popupElement(cam, cameraHits(cam.id, state.hits)));
      cameraLayer.addLayer(marker);
      markers.set(cam.id, { marker, key });
    } else if (entry.key !== key) {
      entry.marker.setStyle(style);
      entry.marker.setRadius(style.radius);
      entry.key = key;
    }
  }
  for (const [id, entry] of markers) {
    if (!keep.has(id)) {
      cameraLayer.removeLayer(entry.marker);
      markers.delete(id);
    }
  }
  renderCameraStatus();
}

/**
 * @param {any} cam
 * @param {{fastest: boolean, avoiding: boolean}} hit
 */
function popupElement(cam, hit) {
  const { title, rows } = cameraPopup(cam, hit);
  const root = document.createElement('div');
  const h = document.createElement('div');
  h.className = 'popup-title';
  h.textContent = title;
  root.append(h);
  for (const [label, value] of rows) {
    const p = document.createElement('p');
    p.className = 'popup-row';
    const b = document.createElement('b');
    b.textContent = `${label}: `;
    p.append(b, value);
    root.append(p);
  }
  return root;
}

// ---- Start / destination ----

function renderEndpoints() {
  endpointLayer.clearLayers();
  const points = [
    [state.click.start, 'Start', 'endpoint endpoint-start'],
    [state.click.end, 'Destination', 'endpoint endpoint-end'],
  ];
  for (const [p, label, className] of /** @type {[any, string, string][]} */ (points)) {
    if (!p) continue;
    L.marker([p.lat, p.lon], {
      icon: L.divIcon({ className, iconSize: [18, 18] }),
      interactive: false,
      keyboard: false,
    })
      .bindTooltip(label, { permanent: true, direction: 'top', offset: [0, -10], className: 'endpoint-label' })
      .addTo(endpointLayer);
  }
  const { start, end } = state.click;
  ui.startInput.value = pointLabel(start, state.names.start);
  ui.endInput.value = pointLabel(end, state.names.end);
  // Under a place name, show where it is; coordinates alone need no second line.
  ui.startText.textContent = start && state.names.start ? pointLabel(start) : '';
  ui.endText.textContent = end && state.names.end ? pointLabel(end) : '';
  ui.hint.textContent = clickHint(state.click);
  renderPlanButton();
}

function renderPlanButton() {
  ui.plan.disabled = state.planning || !state.click.start || !state.click.end;
  ui.plan.textContent = state.planning ? 'Planning...' : 'Plan route';
  ui.plan.classList.toggle('busy', state.planning);
}

/**
 * Set one end of the trip from a search or the device's location.
 * @param {Slot} slot
 * @param {LatLng} point
 * @param {string|null} name
 */
function setPoint(slot, point, name) {
  state.click = { ...state.click, [slot]: { lat: point.lat, lon: point.lon } };
  state.names = { ...state.names, [slot]: name };
  hideResults();
  showError(null);
  clearPlan();
  renderEndpoints();
  const { start, end } = state.click;
  if (start && end) {
    const bounds = L.latLngBounds([
      [start.lat, start.lon],
      [end.lat, end.lon],
    ]);
    map.fitBounds(bounds, { ...fitPadding(), maxZoom: PLACE_ZOOM });
  } else {
    showPoint(point);
  }
}

// ---- Search ----

/** @param {Slot} slot */
function resultsList(slot) {
  return slot === 'start' ? ui.startResults : ui.endResults;
}

function hideResults() {
  for (const list of [ui.startResults, ui.endResults]) {
    list.hidden = true;
    list.replaceChildren();
  }
}

/** @param {Slot} slot */
async function search(slot) {
  const input = slot === 'start' ? ui.startInput : ui.endInput;
  const query = input.value.trim();
  hideResults();
  if (!query) {
    if (state.click[slot]) setPoint(slot, /** @type {LatLng} */ (state.click[slot]), state.names[slot]);
    return;
  }
  if (query === pointLabel(state.click[slot], state.names[slot])) return; // nothing new typed

  const seq = ++state.searchSeq[slot];
  const c = map.getCenter?.();
  const near = c ? `&near=${c.lat.toFixed(4)},${c.lng.toFixed(4)}` : '';
  input.setAttribute('aria-busy', 'true');
  const res = await getJson(`/api/geocode?q=${encodeURIComponent(query)}${near}`);
  input.removeAttribute('aria-busy');
  if (seq !== state.searchSeq[slot]) return;
  if (!res.ok) {
    showError(`Search failed: ${res.message}`);
    return;
  }
  const places = Array.isArray(res.body.results) ? res.body.results : [];
  if (places.length === 1) {
    setPoint(slot, places[0], places[0].name);
    return;
  }
  showResults(slot, places);
}

/**
 * @param {Slot} slot
 * @param {{name: string, detail: string, lat: number, lon: number}[]} places
 */
function showResults(slot, places) {
  const list = resultsList(slot);
  list.replaceChildren();
  if (places.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent =
      state.config.geocoder === 'coordinates'
        ? 'Search is off here. Type coordinates like "35.28, -120.66", or click the map.'
        : 'No places found. Try adding a city, or click the map.';
    list.append(li);
  }
  for (const place of places) {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'option');
    const name = document.createElement('span');
    name.className = 'place-name';
    name.textContent = place.name;
    const detail = document.createElement('span');
    detail.className = 'place-detail';
    detail.textContent = place.detail;
    button.append(name, detail);
    button.addEventListener('click', () => setPoint(slot, place, place.name));
    li.append(button);
    list.append(li);
  }
  list.hidden = false;
}

// ---- Device location ----

const geo = globalThis.navigator?.geolocation;

/** @returns {Promise<LatLng>} */
function locateDevice() {
  return new Promise((resolve, reject) => {
    if (!geo) {
      reject(new Error('This device cannot share its location.'));
      return;
    }
    geo.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      (err) =>
        reject(
          new Error(
            err.code === 1
              ? 'Location is turned off for this app. Allow it in your browser or phone settings.'
              : 'Could not find your location. Try again outdoors, or search instead.',
          ),
        ),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
    );
  });
}

/** @param {LatLng} p */
function showMyLocation(p) {
  myLocationLayer.clearLayers();
  L.marker([p.lat, p.lon], {
    icon: L.divIcon({ className: 'you-are-here', iconSize: [16, 16] }),
    interactive: false,
    keyboard: false,
  }).addTo(myLocationLayer);
}

/**
 * @param {HTMLButtonElement} button
 * @param {(p: LatLng) => void} use
 */
async function withLocation(button, use) {
  button.classList.add('busy');
  showError(null);
  try {
    const p = await locateDevice();
    showMyLocation(p);
    use(p);
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
  } finally {
    button.classList.remove('busy');
  }
}

// ---- Plan ----

function clearPlan() {
  state.plan = null;
  state.planBufferM = null;
  state.hits = { fastest: new Set(), avoiding: new Set() };
  routeLayer.clearLayers();
  ui.results.hidden = true;
  ui.resultsBody.replaceChildren();
  ui.stale.hidden = true;
  renderCameras();
}

async function planRoute() {
  const { start, end } = state.click;
  if (!start || !end || state.planning) return;
  const clickAtRequest = state.click;
  const bufferM = Number(ui.buffer.value);
  state.planning = true;
  renderPlanButton();
  showError(null);
  hideResults();

  const res = await getJson('/api/route', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildRouteRequest(start, end, bufferM)),
  });
  state.planning = false;
  renderPlanButton();
  if (state.click !== clickAtRequest) return; // the user picked new points meanwhile
  if (!res.ok) {
    showError(res.message);
    return;
  }
  showPlan(res.body, bufferM);
}

/**
 * @param {any} plan
 * @param {number} bufferM
 */
function showPlan(plan, bufferM) {
  let summary;
  try {
    summary = summarizePlan(plan);
  } catch {
    showError('The server sent a route plan this page cannot read.');
    return;
  }
  state.plan = plan;
  state.planBufferM = bufferM;
  state.hits = {
    fastest: new Set(plan.fastest.cameraIds),
    avoiding: new Set(plan.avoiding.cameraIds),
  };

  routeLayer.clearLayers();
  // Avoiding (solid, wider) underneath; fastest (gray dashed) on top, so shared roads show both.
  L.polyline(plan.avoiding.route.points, {
    pane: 'routes',
    color: COLORS.avoiding,
    weight: 7,
    opacity: 0.85,
    lineCap: 'round',
    lineJoin: 'round',
    interactive: false,
  }).addTo(routeLayer);
  L.polyline(plan.fastest.route.points, {
    pane: 'routes',
    color: COLORS.fastest,
    weight: 4,
    opacity: 0.95,
    dashArray: '10 8',
    interactive: false,
  }).addTo(routeLayer);

  renderResults(summary);
  renderCameras();
  const bounds = L.latLngBounds([...plan.fastest.route.points, ...plan.avoiding.route.points]);
  if (bounds.isValid()) map.fitBounds(bounds, fitPadding());
}

/** @param {ReturnType<typeof summarizePlan>} s */
function renderResults(s) {
  const body = ui.resultsBody;
  body.replaceChildren();

  /**
   * @param {string} title
   * @param {string} swatchClass
   * @param {{distanceText: string, durationText: string, cameraCount: number, cameraText: string}} r
   * @param {string[]} extra  more badges
   * @param {boolean} recommended
   */
  const block = (title, swatchClass, r, extra, recommended) => {
    const div = document.createElement('div');
    div.className = recommended ? 'result recommended' : 'result';
    const h = document.createElement('h3');
    const sw = document.createElement('span');
    sw.className = `swatch line ${swatchClass}`;
    h.append(sw, title);
    const p = document.createElement('p');
    p.className = 'stats';
    p.textContent = [r.durationText, r.distanceText].join(' · ');
    const badges = document.createElement('div');
    badges.className = 'badges';
    const cams = document.createElement('span');
    cams.className = r.cameraCount === 0 ? 'badge good' : 'badge bad';
    cams.textContent = r.cameraText;
    badges.append(cams);
    for (const text of extra) {
      const b = document.createElement('span');
      b.className = 'badge';
      b.textContent = text;
      badges.append(b);
    }
    div.append(h, p, badges);
    body.append(div);
  };

  const f = s.fastest;
  const a = s.avoiding;
  if (s.same) {
    block('Fastest route', 'fastest', f, [], true);
  } else {
    block('Route avoiding cameras', 'avoiding', a, [a.extraText], true);
    block('Fastest route', 'fastest', f, [], false);
  }
  const verdict = document.createElement('p');
  verdict.className = 'summary';
  verdict.textContent = planVerdict(s);
  body.append(verdict);

  if (s.notes.length) {
    const ul = document.createElement('ul');
    ul.className = 'notes';
    for (const note of s.notes) {
      const li = document.createElement('li');
      li.textContent = note;
      ul.append(li);
    }
    body.append(ul);
  }
  ui.results.hidden = false;
  ui.stale.hidden = true;
}

// ---- Buffer slider ----

function renderBuffer() {
  const value = Number(ui.buffer.value);
  ui.bufferValue.textContent = `${value} m`;
  ui.stale.hidden = !state.plan || value === state.planBufferM;
}

// ---- Events ----

map.on('popupopen', () => {
  state.popupOpen = true;
});
map.on('popupclose', () => {
  state.popupOpen = false;
});
// A click that only closes an open popup should not also move the start or end.
map.on('preclick', () => {
  state.ignoreNextClick = state.popupOpen;
});
map.on('click', (/** @type {any} */ e) => {
  hideResults();
  if (state.ignoreNextClick) {
    state.ignoreNextClick = false;
    return;
  }
  const ll = e.latlng.wrap();
  const prev = state.click;
  const next = nextClickState(prev, { lat: ll.lat, lon: ll.lng });
  // The clicked point has no place name; a new trip also drops the old destination's name.
  if (!prev.start) state.names = { ...state.names, start: null };
  else if (!prev.end) state.names = { ...state.names, end: null };
  else state.names = { start: null, end: null };
  state.click = next;
  if (!next.end) clearPlan();
  showError(null);
  renderEndpoints();
});
map.on('moveend', () => {
  loadCameras();
  const c = map.getCenter?.();
  if (c) prefs.write({ view: { lat: c.lat, lon: c.lng, zoom: map.getZoom() } });
});

for (const [form, slot] of /** @type {[HTMLElement, Slot][]} */ ([
  [ui.startForm, 'start'],
  [ui.endForm, 'end'],
])) {
  form.addEventListener('submit', (/** @type {Event} */ e) => {
    e.preventDefault();
    search(slot);
  });
  form.addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => {
    if (e.key === 'Escape') hideResults();
  });
}

ui.swap.addEventListener('click', () => {
  state.click = { start: state.click.end, end: state.click.start };
  state.names = { start: state.names.end, end: state.names.start };
  hideResults();
  clearPlan();
  renderEndpoints();
});
ui.startLocate.addEventListener('click', () => {
  withLocation(ui.startLocate, (p) => setPoint('start', p, 'My location'));
});
ui.locate.addEventListener('click', () => {
  withLocation(ui.locate, showPoint);
});
ui.sheetHandle.addEventListener('click', () => {
  const collapsed = ui.panel.classList.toggle('collapsed');
  ui.sheetHandle.setAttribute('aria-expanded', String(!collapsed));
  ui.sheetHandle.setAttribute('aria-label', collapsed ? 'Expand panel' : 'Collapse panel');
});

ui.plan.addEventListener('click', () => {
  planRoute();
});
ui.clear.addEventListener('click', () => {
  state.click = { start: null, end: null };
  state.names = { start: null, end: null };
  hideResults();
  showError(null);
  clearPlan();
  renderEndpoints();
});
ui.buffer.addEventListener('input', renderBuffer);
ui.buffer.addEventListener('change', () => prefs.write({ bufferM: Number(ui.buffer.value) }));

// ---- Start ----

async function init() {
  const res = await getJson('/api/config');
  if (res.ok) {
    state.config = { ...FALLBACK_CONFIG, ...res.body };
  } else {
    showError(`Could not load settings from the server: ${res.message}`);
  }
  const config = state.config;
  const saved = prefs.read();

  ui.buffer.min = String(config.minBufferM);
  ui.buffer.max = String(config.maxBufferM);
  ui.buffer.step = String(sliderStep(config));
  const bufferM = Number(saved.bufferM);
  const inRange = Number.isFinite(bufferM) && bufferM >= config.minBufferM && bufferM <= config.maxBufferM;
  ui.buffer.value = String(inRange ? bufferM : config.defaultBufferM);
  renderBuffer();

  const notes = [];
  if (config.cameraSource === 'fixture') notes.push('Offline demo: the cameras are made-up samples in San Luis Obispo.');
  if (config.router === 'stub') notes.push('Routes are straight-line placeholders, not real roads.');
  // Set by the portfolio demo build (demo/transport.js): one area, no device location.
  const demo = config.demo;
  if (demo?.note) notes.push(demo.note);
  ui.sourceNote.textContent = notes.join(' ');
  if (demo?.backLink) {
    const a = document.createElement('a');
    a.href = demo.backLink.href;
    a.textContent = demo.backLink.text;
    ui.sourceNote.append(' ', a);
  }
  ui.sourceNote.hidden = notes.length === 0;
  for (const ex of demo?.examples ?? []) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'secondary';
    button.textContent = ex.name;
    button.addEventListener('click', () => {
      setPoint('start', ex.start, ex.start.name);
      setPoint('end', ex.end, ex.end.name);
      planRoute();
    });
    ui.examples.append(button);
  }
  ui.examples.hidden = !demo?.examples?.length;
  ui.version.textContent = config.version ? `Version ${config.version}.` : '';

  if (config.geocoder === 'coordinates') {
    ui.startInput.placeholder = 'Start: "lat, lon" or use the map';
    ui.endInput.placeholder = 'Destination: "lat, lon" or use the map';
  }
  ui.startLocate.hidden = !geo || !!demo;
  ui.locate.hidden = !geo || !!demo;
  if (demo?.bounds) {
    const b = demo.bounds;
    const area = L.latLngBounds([b.south, b.west], [b.north, b.east]);
    map.setMaxBounds(area.pad(0.1));
    map.setMinZoom(map.getBoundsZoom(area) - 1);
    L.rectangle(area, { color: '#64748b', weight: 1, dashArray: '6 6', fill: false, interactive: false }).addTo(map);
  }

  const v = saved.view;
  const view = v && [v.lat, v.lon, v.zoom].every(Number.isFinite) ? v : { ...config.center, zoom: config.zoom };
  map.setView([view.lat, view.lon], view.zoom);
  renderEndpoints();
  // setView fires moveend, which loads cameras.
}

init();
