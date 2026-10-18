// @ts-check
/**
 * Browser app: Leaflet map with OSM tiles, ALPR camera markers, click-to-set start/end,
 * and fastest vs camera-avoiding routes from the local API. Pure logic lives in lib.js
 * (fixed interface) and view.js; this file is the DOM and Leaflet glue.
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
  sliderStep,
} from './view.js';

/** @type {any} */
const L = /** @type {any} */ (window).L;

/** Used only when GET /api/config fails, so the map still opens. Same values as src/types.js. */
const FALLBACK_CONFIG = {
  center: { lat: 33.749, lon: -84.388 },
  zoom: 13,
  minCameraZoom: 12,
  defaultBufferM: 75,
  minBufferM: 15,
  maxBufferM: 300,
  maxTripM: 50000,
  maxBboxSpanDeg: 0.5,
  cameraSource: 'unknown',
  router: 'unknown',
  appTitle: 'ALPR Route Planner',
};

const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>';

/** @param {string} id */
function $(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}

const ui = {
  hint: $('hint'),
  startText: $('start-text'),
  endText: $('end-text'),
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
};

const state = {
  config: FALLBACK_CONFIG,
  /** @type {{start: {lat: number, lon: number}|null, end: {lat: number, lon: number}|null}} */
  click: { start: null, end: null },
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
 * fetch + JSON with the API's {error} messages.
 * @param {string} url
 * @param {RequestInit} [options]
 * @returns {Promise<{ok: true, body: any} | {ok: false, aborted?: boolean, message: string}>}
 */
async function getJson(url, options) {
  let res;
  try {
    res = await fetch(url, options);
  } catch (err) {
    if (err && /** @type {any} */ (err).name === 'AbortError') return { ok: false, aborted: true, message: '' };
    return { ok: false, message: 'Could not reach the server. Is it running?' };
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

if (!L) {
  showError('Could not load the map library (Leaflet) from unpkg.com. Check your connection and reload.');
  throw new Error('Leaflet not loaded');
}

// ---- Map ----

const map = L.map('map', { preferCanvas: true, zoomControl: true });
// Routes under cameras. Each pane gets its own canvas, and a canvas takes every click on it, so
// cameras must be the top canvas; start/end are DOM markers in Leaflet's marker pane instead.
for (const [name, z] of [['routes', 410], ['cameras', 420]]) {
  map.createPane(name).style.zIndex = String(z);
}
L.tileLayer(TILE_URL, { maxZoom: 19, attribution: TILE_ATTRIBUTION }).addTo(map);

const routeLayer = L.layerGroup().addTo(map);
const cameraLayer = L.layerGroup().addTo(map);
const endpointLayer = L.layerGroup().addTo(map);
/** id -> {marker, key} so markers (and open popups) survive pans. @type {Map<string, {marker: any, key: string}>} */
const markers = new Map();

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

// ---- Start / end ----

/** @param {{lat: number, lon: number}|null} p */
function pointText(p) {
  return p ? `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}` : 'not set';
}

function renderEndpoints() {
  endpointLayer.clearLayers();
  const points = [
    [state.click.start, 'Start', 'endpoint endpoint-start'],
    [state.click.end, 'End', 'endpoint endpoint-end'],
  ];
  for (const [p, label, className] of /** @type {[any, string, string][]} */ (points)) {
    if (!p) continue;
    L.marker([p.lat, p.lon], {
      icon: L.divIcon({ className, iconSize: [16, 16] }),
      interactive: false,
      keyboard: false,
    })
      .bindTooltip(label, { permanent: true, direction: 'top', offset: [0, -8] })
      .addTo(endpointLayer);
  }
  ui.startText.textContent = pointText(state.click.start);
  ui.endText.textContent = pointText(state.click.end);
  ui.hint.textContent = clickHint(state.click);
  renderPlanButton();
}

function renderPlanButton() {
  ui.plan.disabled = state.planning || !state.click.start || !state.click.end;
  ui.plan.textContent = state.planning ? 'Planning...' : 'Plan route';
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
  if (bounds.isValid()) map.fitBounds(bounds, { padding: [30, 30] });
}

/** @param {ReturnType<typeof summarizePlan>} s */
function renderResults(s) {
  const body = ui.resultsBody;
  body.replaceChildren();

  /**
   * @param {string} title
   * @param {string} swatchClass
   * @param {string[]} parts
   */
  const block = (title, swatchClass, parts) => {
    const div = document.createElement('div');
    div.className = 'result';
    const h = document.createElement('h3');
    const sw = document.createElement('span');
    sw.className = `swatch line ${swatchClass}`;
    h.append(sw, title);
    const p = document.createElement('p');
    p.className = 'stats';
    p.textContent = parts.join(' · ');
    div.append(h, p);
    body.append(div);
  };

  const f = s.fastest;
  const a = s.avoiding;
  if (s.same) {
    block('Fastest route', 'fastest', [f.distanceText, f.durationText, f.cameraText]);
    const p = document.createElement('p');
    p.textContent =
      f.cameraCount === 0
        ? 'It passes no mapped cameras, so there is nothing to avoid.'
        : 'No other route passes fewer mapped cameras, so both lines are the same.';
    body.append(p);
  } else {
    block('Fastest route', 'fastest', [f.distanceText, f.durationText, f.cameraText]);
    block('Route avoiding cameras', 'avoiding', [a.distanceText, a.durationText, a.cameraText, a.extraText]);
  }

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
  if (state.ignoreNextClick) {
    state.ignoreNextClick = false;
    return;
  }
  const ll = e.latlng.wrap();
  const next = nextClickState(state.click, { lat: ll.lat, lon: ll.lng });
  state.click = next;
  if (!next.end) clearPlan();
  showError(null);
  renderEndpoints();
});
map.on('moveend', () => {
  loadCameras();
});

ui.plan.addEventListener('click', () => {
  planRoute();
});
ui.clear.addEventListener('click', () => {
  state.click = { start: null, end: null };
  showError(null);
  clearPlan();
  renderEndpoints();
});
ui.buffer.addEventListener('input', renderBuffer);

// ---- Start ----

async function init() {
  const res = await getJson('/api/config');
  if (res.ok) {
    state.config = { ...FALLBACK_CONFIG, ...res.body };
  } else {
    showError(`Could not load settings from the server: ${res.message}`);
  }
  const config = state.config;

  ui.buffer.min = String(config.minBufferM);
  ui.buffer.max = String(config.maxBufferM);
  ui.buffer.step = String(sliderStep(config));
  ui.buffer.value = String(config.defaultBufferM);
  renderBuffer();

  const notes = [];
  if (config.cameraSource === 'fixture') notes.push('Offline demo: the cameras are made-up samples in central Atlanta.');
  if (config.router === 'stub') notes.push('Routes are straight-line placeholders, not real roads.');
  ui.sourceNote.textContent = notes.join(' ');
  ui.sourceNote.hidden = notes.length === 0;

  map.setView([config.center.lat, config.center.lon], config.zoom);
  renderEndpoints();
  // setView fires moveend, which loads cameras.
}

init();
