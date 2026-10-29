/**
 * Smoke tests for public/index.html and public/app.js. app.js runs against a fake Leaflet,
 * a fake DOM built from the ids in index.html, and a fake fetch; nothing touches the network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildRouteRequest } from '../../public/lib.js';
import { COLORS } from '../../public/view.js';

const PUBLIC = new URL('../../public/', import.meta.url);
const html = await readFile(new URL('index.html', PUBLIC), 'utf8');
const css = await readFile(new URL('style.css', PUBLIC), 'utf8');

// ---- index.html / style.css ----

test('page title and heading are "ALPR Route Planner"', () => {
  assert.match(html, /<title>ALPR Route Planner<\/title>/);
  assert.match(html, /<h1>ALPR Route Planner<\/h1>/);
});

test('page loads Leaflet 1.9.4 from unpkg, pinned, with integrity', () => {
  assert.match(
    html,
    /<link rel="stylesheet" href="https:\/\/unpkg\.com\/leaflet@1\.9\.4\/dist\/leaflet\.css"\s+integrity="sha256-p4NxAoJBhIIN\+hmNHrzRCf9tD\/miZyoHS5obTRR9BMY=" crossorigin="">/,
  );
  assert.match(
    html,
    /<script src="https:\/\/unpkg\.com\/leaflet@1\.9\.4\/dist\/leaflet\.js"\s+integrity="sha256-20nQCchB9co0qIjJZRGuk2\/Z9VM\+kNiyxNV1lvTlZBo=" crossorigin=""><\/script>/,
  );
  assert.match(html, /<script type="module" src="app\.js"><\/script>/);
  // Leaflet (classic script) must come before app.js (module, deferred) so window.L exists.
  assert.ok(html.indexOf('leaflet.js') < html.indexOf('app.js'));
});

test('page says coverage is incomplete, credits OpenStreetMap, and disclaims Flock Safety', () => {
  assert.match(html, /Coverage is incomplete\./);
  assert.match(html, /A route that avoids every mapped camera can still pass unmapped ones\./);
  assert.match(html, /&copy; <a href="https:\/\/www\.openstreetmap\.org\/copyright"[^>]*>OpenStreetMap contributors<\/a>/);
  assert.match(html, /Not affiliated with Flock Safety\./);
});

test('page and stylesheet use no images', () => {
  assert.doesNotMatch(html, /<img\b|<svg\b|\.png|\.jpe?g|\.gif|\.webp/i);
  assert.doesNotMatch(css, /url\(/i);
});

// ---- Fakes ----

class FakeElement {
  /** @param {string} tag @param {string} [id] */
  constructor(tag, id = '') {
    this.tagName = tag;
    this.id = id;
    this.textContent = '';
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.min = '';
    this.max = '';
    this.step = '';
    this.className = '';
    /** @type {(FakeElement|string)[]} */
    this.children = [];
    /** @type {Record<string, Function[]>} */
    this.listeners = {};
  }
  /** @param {string} type @param {Function} fn */
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  /** @param {string} type */
  dispatch(type) {
    for (const fn of this.listeners[type] || []) fn({ type, target: this });
  }
  /** @param {...(FakeElement|string)} nodes */
  append(...nodes) {
    this.children.push(...nodes);
  }
  /** @param {...(FakeElement|string)} nodes */
  replaceChildren(...nodes) {
    this.children = nodes;
  }
  /** All text inside, like innerText without spacing rules. @returns {string} */
  get text() {
    return this.textContent + this.children.map((c) => (typeof c === 'string' ? c : c.text)).join('');
  }
  /** @param {string} cls @returns {FakeElement[]} */
  findAll(cls) {
    const out = [];
    for (const c of this.children) {
      if (typeof c === 'string') continue;
      if (c.className.split(' ').includes(cls)) out.push(c);
      out.push(...c.findAll(cls));
    }
    return out;
  }
}

function makeDocument() {
  /** @type {Map<string, FakeElement>} */
  const byId = new Map();
  for (const m of html.matchAll(/<(\w+)[^>]*\sid="([^"]+)"[^>]*>/g)) {
    const el = new FakeElement(m[1], m[2]);
    if (/\shidden[\s>]/.test(m[0])) el.hidden = true;
    if (/\sdisabled[\s>]/.test(m[0])) el.disabled = true;
    byId.set(m[2], el);
  }
  return {
    byId,
    getElementById: (/** @type {string} */ id) => byId.get(id) ?? null,
    createElement: (/** @type {string} */ tag) => new FakeElement(tag),
  };
}

class Evented {
  constructor() {
    /** @type {Record<string, Function[]>} */
    this.handlers = {};
  }
  /** @param {string} type @param {Function} fn */
  on(type, fn) {
    (this.handlers[type] ||= []).push(fn);
    return this;
  }
  /** @param {string} type @param {object} [data] */
  fire(type, data = {}) {
    for (const fn of this.handlers[type] || []) fn({ type, ...data });
    return this;
  }
}

class FakeLayer {
  /** @param {any} target */
  addTo(target) {
    target.addLayer(this);
    return this;
  }
}

class FakeGroup extends FakeLayer {
  constructor() {
    super();
    this.layers = new Set();
  }
  /** @param {any} l */
  addLayer(l) {
    this.layers.add(l);
    return this;
  }
  /** @param {any} l */
  removeLayer(l) {
    this.layers.delete(l);
    return this;
  }
  clearLayers() {
    this.layers.clear();
    return this;
  }
}

class FakeCircleMarker extends FakeLayer {
  /** @param {[number, number]} latlng @param {any} options */
  constructor(latlng, options) {
    super();
    this.latlng = latlng;
    this.options = { ...options };
  }
  /** @param {any} content */
  bindPopup(content) {
    this.popup = content;
    return this;
  }
  /** @param {string} text @param {any} options */
  bindTooltip(text, options) {
    this.tooltip = { text, options };
    return this;
  }
  /** @param {any} style */
  setStyle(style) {
    Object.assign(this.options, style);
    return this;
  }
  /** @param {number} r */
  setRadius(r) {
    this.options.radius = r;
    return this;
  }
}

class FakePolyline extends FakeLayer {
  /** @param {any} points @param {any} options */
  constructor(points, options) {
    super();
    this.points = points;
    this.options = options;
  }
}

class FakeMap extends Evented {
  /** @param {string} id @param {any} options */
  constructor(id, options) {
    super();
    this.id = id;
    this.options = options;
    /** @type {Record<string, {style: Record<string, string>}>} */
    this.panes = {};
    /** @type {any[]} */
    this.layers = [];
    /** @type {number|undefined} */
    this.zoom = undefined;
    /** @type {[number, number]|null} */
    this.center = null;
    this.span = { lat: 0.1, lon: 0.2 };
    /** @type {any} */
    this.fitted = null;
  }
  /** @param {string} name */
  createPane(name) {
    return (this.panes[name] = { style: {} });
  }
  /** @param {any} l */
  addLayer(l) {
    this.layers.push(l);
    return this;
  }
  /** @param {[number, number]} center @param {number} zoom */
  setView(center, zoom) {
    this.center = center;
    this.zoom = zoom;
    this.fire('moveend');
    return this;
  }
  getZoom() {
    return this.zoom;
  }
  getBounds() {
    const [lat, lon] = /** @type {[number, number]} */ (this.center);
    const { span } = this;
    return {
      getSouth: () => lat - span.lat / 2,
      getNorth: () => lat + span.lat / 2,
      getWest: () => lon - span.lon / 2,
      getEast: () => lon + span.lon / 2,
    };
  }
  /** @param {any} bounds @param {any} options */
  fitBounds(bounds, options) {
    this.fitted = { bounds, options };
    this.fire('moveend');
    return this;
  }
  /** @param {number} lat @param {number} lng */
  click(lat, lng) {
    this.fire('preclick');
    this.fire('click', { latlng: { lat, lng, wrap: () => ({ lat, lng }) } });
  }
}

function makeLeaflet() {
  /** @type {FakeMap[]} */
  const maps = [];
  /** @type {FakePolyline[]} */
  const polylines = [];
  const L = {
    map: (/** @type {string} */ id, /** @type {any} */ o) => {
      const m = new FakeMap(id, o);
      maps.push(m);
      return m;
    },
    tileLayer: (/** @type {string} */ url, /** @type {any} */ options) => Object.assign(new FakeLayer(), { url, options }),
    layerGroup: () => new FakeGroup(),
    circleMarker: (/** @type {any} */ ll, /** @type {any} */ o) => new FakeCircleMarker(ll, o),
    marker: (/** @type {any} */ ll, /** @type {any} */ o) => Object.assign(new FakeCircleMarker(ll, o), { kind: 'marker' }),
    divIcon: (/** @type {any} */ o) => ({ kind: 'divIcon', options: o }),
    polyline: (/** @type {any} */ p, /** @type {any} */ o) => {
      const line = new FakePolyline(p, o);
      polylines.push(line);
      return line;
    },
    latLngBounds: (/** @type {any[]} */ pts) => ({ pts, isValid: () => pts.length > 0 }),
  };
  return { L, maps, polylines };
}

const CONFIG = {
  center: { lat: 33.749, lon: -84.388 },
  zoom: 13,
  minCameraZoom: 12,
  defaultBufferM: 75,
  minBufferM: 15,
  maxBufferM: 300,
  maxTripM: 50000,
  maxBboxSpanDeg: 0.5,
  cameraSource: 'fixture',
  router: 'stub',
  appTitle: 'ALPR Route Planner',
};

const CAMERAS = [
  { id: 'sample:1', lat: 33.75, lon: -84.39, isFlock: true, manufacturer: 'Flock Safety', operator: 'City <b>PD</b>', direction: null, source: 'sample' },
  { id: 'sample:2', lat: 33.76, lon: -84.38, isFlock: false, manufacturer: null, operator: null, direction: 90, source: 'sample' },
];

const PLAN = {
  fastest: {
    route: { points: [[33.74, -84.4], [33.76, -84.37]], distanceM: 3400, durationS: 720 },
    cameraIds: ['sample:1', 'sample:3'],
  },
  avoiding: {
    route: { points: [[33.74, -84.4], [33.73, -84.38], [33.76, -84.37]], distanceM: 4100, durationS: 900 },
    cameraIds: [],
  },
  cameras: [
    ...CAMERAS,
    { id: 'sample:3', lat: 33.745, lon: -84.395, isFlock: false, manufacturer: 'Motorola', operator: null, direction: null, source: 'sample' },
  ],
  bufferM: 75,
  iterations: 1,
  notes: ['No other route was found.'],
};

/**
 * @param {Record<string, (url: string, init: any) => {status: number, body?: any, throws?: boolean}>} routes
 */
function makeFetch(routes) {
  /** @type {{url: string, init: any}[]} */
  const calls = [];
  const fetch = async (/** @type {string} */ url, /** @type {any} */ init = {}) => {
    calls.push({ url, init });
    const path = url.split('?')[0];
    const handler = routes[path];
    const r = handler ? handler(url, init) : { status: 404, body: { error: 'Not found', code: 'NOT_FOUND' } };
    if (r.throws) throw new TypeError('fetch failed');
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => {
        if (r.body === undefined) throw new SyntaxError('Unexpected end of JSON input');
        return structuredClone(r.body);
      },
    };
  };
  return { fetch, calls };
}

const defaultRoutes = {
  '/api/config': () => ({ status: 200, body: CONFIG }),
  '/api/cameras': () => ({ status: 200, body: { cameras: CAMERAS, source: 'fixture' } }),
  '/api/route': () => ({ status: 200, body: PLAN }),
};

let runId = 0;

/** Load a fresh copy of app.js against new fakes. */
async function startApp(routes = defaultRoutes) {
  const doc = makeDocument();
  const leaflet = makeLeaflet();
  const net = makeFetch(routes);
  Object.assign(globalThis, { window: { L: leaflet.L }, document: doc, fetch: net.fetch });
  runId += 1;
  await import(new URL(`app.js?run=${runId}`, PUBLIC).href);
  await settle();
  const map = leaflet.maps[0];
  const [, routeLayer, cameraLayer, endpointLayer] = map.layers;
  return {
    doc,
    el: (/** @type {string} */ id) => /** @type {FakeElement} */ (doc.byId.get(id)),
    map,
    net,
    polylines: leaflet.polylines,
    routeLayer: /** @type {FakeGroup} */ (routeLayer),
    cameraLayer: /** @type {FakeGroup} */ (cameraLayer),
    endpointLayer: /** @type {FakeGroup} */ (endpointLayer),
  };
}

async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

/** @param {FakeGroup} group */
function markersById(group) {
  const out = new Map();
  for (const m of group.layers) out.set(`${m.latlng[0]},${m.latlng[1]}`, m);
  return out;
}

// ---- app.js ----

test('app starts: config, OSM tiles with attribution, slider limits, offline note', async () => {
  const app = await startApp();
  assert.equal(app.net.calls[0].url, '/api/config');
  assert.deepEqual(app.map.center, [33.749, -84.388]);
  assert.equal(app.map.zoom, 13);

  const tiles = app.map.layers[0];
  assert.equal(tiles.url, 'https://tile.openstreetmap.org/{z}/{x}/{y}.png');
  assert.match(tiles.options.attribution, /&copy; <a href="https:\/\/www\.openstreetmap\.org\/copyright">OpenStreetMap contributors<\/a>/);

  const buffer = app.el('buffer');
  assert.equal(buffer.min, '15');
  assert.equal(buffer.max, '300');
  assert.equal(buffer.value, '75');
  assert.equal(buffer.step, '5');
  assert.equal(app.el('buffer-value').textContent, '75 m');

  assert.equal(app.el('source-note').hidden, false);
  assert.match(app.el('source-note').textContent, /made-up samples/);
  assert.equal(app.el('hint').textContent, 'Click the map to set the start.');
  assert.equal(app.el('plan').disabled, true);
  assert.equal(app.el('error').hidden, true);
});

test('app loads cameras for the view and colors Flock vs other ALPRs', async () => {
  const app = await startApp();
  const camCalls = app.net.calls.filter((c) => c.url.startsWith('/api/cameras'));
  assert.equal(camCalls.length, 1);
  assert.equal(camCalls[0].url, '/api/cameras?bbox=33.699,-84.488,33.799,-84.288');

  const markers = markersById(app.cameraLayer);
  assert.equal(markers.size, 2);
  const flock = markers.get('33.75,-84.39');
  const other = markers.get('33.76,-84.38');
  assert.equal(flock.options.fillColor, COLORS.flock);
  assert.equal(other.options.fillColor, COLORS.otherAlpr);
  assert.equal(flock.options.bubblingMouseEvents, false);
  assert.equal(app.el('camera-status').textContent, '2 cameras in view.');

  const popup = flock.popup();
  assert.equal(popup.text, 'Flock ALPR camera' + 'Manufacturer: Flock Safety' + 'Operator: City <b>PD</b>');
  // Operator text is a text node, never parsed as HTML.
  assert.ok(popup.children[2].children.includes('City <b>PD</b>'));
  assert.equal(other.popup().text, 'ALPR camera' + 'Manufacturer: unknown' + 'Operator: unknown');
});

test('app clips a too-wide view to the API bbox limit', async () => {
  const app = await startApp();
  app.map.span = { lat: 0.4, lon: 0.9 };
  app.map.fire('moveend');
  await settle();
  const last = app.net.calls.filter((c) => c.url.startsWith('/api/cameras')).at(-1);
  const [s, w, n, e] = last.url.split('=')[1].split(',').map(Number);
  assert.ok(n - s <= 0.5 && e - w <= 0.5, last.url);
  assert.match(app.el('camera-status').textContent, /near the center of the view/);
});

test('app skips camera loading when zoomed out', async () => {
  const app = await startApp();
  const before = app.net.calls.length;
  app.map.zoom = 11;
  app.map.fire('moveend');
  await settle();
  assert.equal(app.net.calls.length, before);
  assert.equal(app.cameraLayer.layers.size, 0);
  assert.equal(app.el('camera-status').textContent, 'Zoom in to see cameras.');
});

test('app shows the API error when cameras fail to load', async () => {
  const app = await startApp({
    ...defaultRoutes,
    '/api/cameras': () => ({ status: 502, body: { error: 'overpass: HTTP 504', code: 'UPSTREAM' } }),
  });
  assert.equal(app.el('camera-status').textContent, 'Could not load cameras: overpass: HTTP 504');
});

test('app click cycle sets start, end, then a new start', async () => {
  const app = await startApp();
  app.map.click(33.74, -84.4);
  assert.equal(app.el('start-text').textContent, '33.74000, -84.40000');
  assert.equal(app.el('end-text').textContent, 'not set');
  assert.equal(app.el('hint').textContent, 'Click the map to set the end.');
  assert.equal(app.el('plan').disabled, true);
  assert.equal(app.endpointLayer.layers.size, 1);

  app.map.click(33.76, -84.37);
  assert.equal(app.el('end-text').textContent, '33.76000, -84.37000');
  assert.equal(app.el('plan').disabled, false);
  assert.equal(app.endpointLayer.layers.size, 2);
  const ends = [...app.endpointLayer.layers];
  assert.deepEqual(ends.map((m) => m.tooltip.text), ['Start', 'End']);
  // DOM markers that ignore the mouse: a canvas pane above the cameras would swallow their clicks.
  for (const m of ends) {
    assert.equal(m.kind, 'marker');
    assert.equal(m.options.interactive, false);
    assert.equal(m.options.icon.kind, 'divIcon');
  }
  assert.deepEqual(ends.map((m) => m.options.icon.options.className), [
    'endpoint endpoint-start',
    'endpoint endpoint-end',
  ]);
  assert.deepEqual(Object.keys(app.map.panes), ['routes', 'cameras']);
  assert.ok(Number(app.map.panes.routes.style.zIndex) < Number(app.map.panes.cameras.style.zIndex));

  app.map.click(33.7, -84.3);
  assert.equal(app.el('start-text').textContent, '33.70000, -84.30000');
  assert.equal(app.el('end-text').textContent, 'not set');
  assert.equal(app.el('plan').disabled, true);
});

test('app click that closes a popup does not move the points', async () => {
  const app = await startApp();
  app.map.fire('popupopen');
  app.map.click(33.74, -84.4);
  assert.equal(app.el('start-text').textContent, 'not set');
  app.map.fire('popupclose');
  app.map.click(33.74, -84.4);
  assert.equal(app.el('start-text').textContent, '33.74000, -84.40000');
});

test('app plans a route: request body, both lines, highlights and results', async () => {
  const app = await startApp();
  app.map.click(33.74, -84.4);
  app.map.click(33.76, -84.37);
  app.el('buffer').value = '100';
  app.el('buffer').dispatch('input');
  assert.equal(app.el('buffer-value').textContent, '100 m');

  app.el('plan').dispatch('click');
  assert.equal(app.el('plan').disabled, true);
  assert.equal(app.el('plan').textContent, 'Planning...');
  await settle();

  const post = app.net.calls.find((c) => c.url === '/api/route');
  assert.ok(post);
  assert.equal(post.init.method, 'POST');
  assert.equal(post.init.headers['Content-Type'], 'application/json');
  assert.deepEqual(
    JSON.parse(post.init.body),
    buildRouteRequest({ lat: 33.74, lon: -84.4 }, { lat: 33.76, lon: -84.37 }, 100),
  );
  assert.equal(app.el('plan').textContent, 'Plan route');
  assert.equal(app.el('plan').disabled, false);

  const lines = [...app.routeLayer.layers];
  assert.equal(lines.length, 2);
  const fastest = lines.find((l) => l.options.dashArray);
  const avoiding = lines.find((l) => !l.options.dashArray);
  assert.deepEqual(fastest.points, PLAN.fastest.route.points);
  assert.equal(fastest.options.color, COLORS.fastest);
  assert.ok(fastest.options.dashArray);
  assert.deepEqual(avoiding.points, PLAN.avoiding.route.points);
  assert.equal(avoiding.options.color, COLORS.avoiding);
  assert.equal(avoiding.options.interactive, false);
  assert.ok(app.map.fitted);

  const markers = markersById(app.cameraLayer);
  assert.equal(markers.size, 3, 'plan cameras are added to the map');
  assert.equal(markers.get('33.75,-84.39').options.radius, 9);
  assert.equal(markers.get('33.75,-84.39').options.color, COLORS.hitOutline);
  assert.equal(markers.get('33.76,-84.38').options.radius, 6);
  assert.match(markers.get('33.745,-84.395').popup().text, /Next to: fastest route/);

  assert.equal(app.el('results').hidden, false);
  const text = app.el('results-body').text;
  assert.match(text, /Fastest route3\.4 km · 12 min · 2 cameras/);
  assert.match(text, /Route avoiding cameras4\.1 km · 15 min · No cameras · \+3 min/);
  assert.match(text, /No other route was found\./);
  assert.equal(app.el('stale').hidden, true);

  app.el('buffer').value = '150';
  app.el('buffer').dispatch('input');
  assert.equal(app.el('stale').hidden, false);
  app.el('buffer').value = '100';
  app.el('buffer').dispatch('input');
  assert.equal(app.el('stale').hidden, true);

  // A third click starts over and clears the plan.
  app.map.click(33.7, -84.3);
  assert.equal(app.routeLayer.layers.size, 0);
  assert.equal(app.el('results').hidden, true);
  assert.equal(markersById(app.cameraLayer).get('33.75,-84.39').options.radius, 6);
});

test('app shows one result when both routes are the same', async () => {
  const same = structuredClone(PLAN);
  same.fastest.cameraIds = [];
  same.avoiding = structuredClone(same.fastest);
  same.notes = [];
  const app = await startApp({ ...defaultRoutes, '/api/route': () => ({ status: 200, body: same }) });
  app.map.click(33.74, -84.4);
  app.map.click(33.76, -84.37);
  app.el('plan').dispatch('click');
  await settle();
  const body = app.el('results-body');
  assert.equal(body.findAll('result').length, 1);
  assert.match(body.text, /It passes no mapped cameras, so there is nothing to avoid\./);
});

test('app shows the {error} message from a failed plan', async () => {
  const app = await startApp({
    ...defaultRoutes,
    '/api/route': () => ({
      status: 422,
      body: { error: 'Start and end are more than 50 km apart.', code: 'TRIP_TOO_LONG' },
    }),
  });
  app.map.click(33.74, -84.4);
  app.map.click(34.9, -84.37);
  app.el('plan').dispatch('click');
  await settle();
  assert.equal(app.el('error').hidden, false);
  assert.equal(app.el('error').textContent, 'Start and end are more than 50 km apart.');
  assert.equal(app.el('results').hidden, true);
  assert.equal(app.routeLayer.layers.size, 0);

  // Picking a new point hides the error.
  app.map.click(33.7, -84.3);
  assert.equal(app.el('error').hidden, true);
});

test('app ignores a plan that arrives after the points changed', async () => {
  /** @type {(v: any) => void} */
  let release = () => {};
  const gate = new Promise((r) => (release = r));
  const app = await startApp({ ...defaultRoutes, '/api/route': () => ({ status: 200, body: PLAN }) });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (url === '/api/route') await gate;
    return realFetch(url, init);
  };
  app.map.click(33.74, -84.4);
  app.map.click(33.76, -84.37);
  app.el('plan').dispatch('click');
  await settle();
  app.map.click(33.7, -84.3);
  release(null);
  await settle();
  assert.equal(app.routeLayer.layers.size, 0);
  assert.equal(app.el('results').hidden, true);
});

test('app clear button resets points and plan', async () => {
  const app = await startApp();
  app.map.click(33.74, -84.4);
  app.map.click(33.76, -84.37);
  app.el('plan').dispatch('click');
  await settle();
  app.el('clear').dispatch('click');
  assert.equal(app.el('start-text').textContent, 'not set');
  assert.equal(app.el('end-text').textContent, 'not set');
  assert.equal(app.endpointLayer.layers.size, 0);
  assert.equal(app.routeLayer.layers.size, 0);
  assert.equal(app.el('results').hidden, true);
});

test('app still opens the map when the server is unreachable', async () => {
  const app = await startApp({
    '/api/config': () => ({ status: 0, throws: true }),
    '/api/cameras': () => ({ status: 0, throws: true }),
  });
  assert.deepEqual(app.map.center, [35.2828, -120.6596]);
  assert.equal(app.el('error').hidden, false);
  assert.equal(
    app.el('error').textContent,
    'Could not load settings from the server: Could not reach the server. Is it running?',
  );
  assert.equal(app.el('camera-status').textContent, 'Could not load cameras: Could not reach the server. Is it running?');
});
