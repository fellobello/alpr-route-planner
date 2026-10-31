// @ts-check
/**
 * Portfolio demo's stand-in for public/transport.js: answers the app's /api/* requests in the
 * browser with the same code the Node server runs (src/api.js), like the Android build does,
 * but limited to San Luis Obispo. Cameras come from a saved snapshot (slo-cameras.json, made by
 * demo/snapshot.js), routes from the public Valhalla server, search from Nominatim.
 */
import { createApi, errorStatus } from './src/api.js';
import { ValhallaRouter } from './src/routing/valhalla.js';
import { NominatimGeocoder } from './src/geocode/nominatim.js';
import { InputError } from './src/types.js';
import { DEMO_AREA, inDemoArea } from './area.js';

/** Map view and search bias: downtown San Luis Obispo. */
const SLO = Object.freeze({ lat: 35.2828, lon: -120.6596 });

/** One-click trips shown in the panel. */
const EXAMPLES = [
  { name: 'Johnson Ave to Laguna Lake', start: { lat: 35.278, lon: -120.642, name: 'Johnson Ave' }, end: { lat: 35.261, lon: -120.687, name: 'Laguna Lake Park' } },
  { name: 'Tank Farm Rd to Foothill', start: { lat: 35.247, lon: -120.66, name: 'Tank Farm Rd' }, end: { lat: 35.2945, lon: -120.6735, name: 'Foothill Blvd' } },
  { name: 'Airport to Cal Poly', start: { lat: 35.2368, lon: -120.6414, name: 'SLO Airport' }, end: { lat: 35.3005, lon: -120.6625, name: 'Cal Poly' } },
];

const snapshot = await fetch('./slo-cameras.json').then((res) => res.json());
/** @type {import('./src/types.js').Camera[]} */
const allCameras = snapshot.cameras;
const savedMonth = new Date(`${snapshot.savedAt}T12:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

/** @type {import('./src/types.js').CameraSource} */
const cameraSource = {
  name: 'snapshot',
  getCameras: async (b) => allCameras.filter((c) => c.lat >= b.south && c.lat <= b.north && c.lon >= b.west && c.lon <= b.east),
};

/**
 * Browsers either drop a User-Agent header or send it in a CORS preflight that Valhalla refuses,
 * so leave it off; the browser sends its own.
 * @type {typeof fetch}
 */
const browserFetch = (input, init) => {
  const headers = new Headers(init?.headers);
  headers.delete('User-Agent');
  return fetch(input, { ...init, headers });
};

const nominatim = new NominatimGeocoder({ fetch: browserFetch });

/**
 * Nominatim's viewbox only biases results, so drop places outside the demo area and, if none
 * are left, try once more with the county named.
 * @type {import('./src/types.js').Geocoder}
 */
const geocoder = {
  name: 'nominatim',
  async search(query) {
    const local = (await nominatim.search(query, SLO)).filter(inDemoArea);
    if (local.length) return local;
    return (await nominatim.search(`${query}, San Luis Obispo County, California`, SLO)).filter(inDemoArea);
  },
};

const api = createApi({ cameraSource, router: new ValhallaRouter({ fetch: browserFetch }), geocoder });

/** @param {any} body */
function route(body) {
  if (!inDemoArea(body?.start ?? {}) || !inDemoArea(body?.end ?? {})) {
    throw new InputError('This demo only covers San Luis Obispo, Los Osos and Morro Bay. Pick points inside the box.');
  }
  return api.route(body);
}

async function config() {
  return {
    ...(await api.config()),
    center: SLO,
    demo: {
      note: `Portfolio demo: San Luis Obispo only, cameras from OpenStreetMap as of ${savedMonth}.`,
      bounds: DEMO_AREA,
      examples: EXAMPLES,
      backLink: { href: '../alpr-route-planner.html', text: 'About this project' },
    },
  };
}

/**
 * @param {number} status
 * @param {unknown} body
 */
function respond(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => structuredClone(body) };
}

/**
 * @param {URL} url
 * @param {RequestInit} init
 */
async function dispatch(url, init) {
  const method = (init.method || 'GET').toUpperCase();
  const q = url.searchParams;
  switch (`${method} ${url.pathname}`) {
    case 'GET /api/health':
      return api.health();
    case 'GET /api/config':
      return config();
    case 'GET /api/cameras':
      return api.cameras(q.get('bbox'));
    case 'GET /api/geocode':
      return api.geocode(q.get('q'), q.get('near'));
    case 'POST /api/route':
      return route(JSON.parse(String(init.body ?? '{}')));
    default:
      return Promise.reject(Object.assign(new Error(`No API endpoint ${method} ${url.pathname}`), { status: 404, code: 'NOT_FOUND' }));
  }
}

/**
 * @param {string} url
 * @param {RequestInit} [init]
 */
export async function apiFetch(url, init = {}) {
  const signal = init.signal;
  try {
    const body = await dispatch(new URL(url, 'https://localhost'), init);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    return respond(200, body);
  } catch (err) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const e = /** @type {any} */ (err);
    const status = e?.status ?? (err instanceof SyntaxError ? 400 : errorStatus(err));
    if (status === 500) console.error('[api]', err);
    const code = status !== 500 && typeof e?.code === 'string' ? e.code : 'INTERNAL';
    return respond(status, { error: status === 500 ? 'Something went wrong in the app.' : String(e?.message ?? err), code });
  }
}
