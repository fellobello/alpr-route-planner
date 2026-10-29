// @ts-check
/**
 * Android build's stand-in for public/transport.js: answers the app's /api/* requests on the
 * device with the same code the Node server runs (src/api.js), talking to Overpass, Valhalla and
 * Nominatim directly. Camera tiles are kept in localStorage, so areas seen before open at once
 * and still show when Overpass is slow or down.
 */
import { createApi, errorStatus } from './src/api.js';
import { OVERPASS_ENDPOINTS, OverpassCameraSource } from './src/cameras/overpass.js';
import { ValhallaRouter } from './src/routing/valhalla.js';
import { NominatimGeocoder } from './src/geocode/nominatim.js';

const TILES_KEY = 'alpr-route-planner:overpass-tiles';
/** About 1.5 kB per tile; this keeps the cache well under the WebView's storage quota. */
const MAX_STORED_TILES = 1500;

/**
 * Tiles bundled into the app at build time (the server's cache, if it had one), used until the
 * device has saved tiles of its own. They are old, so they are refreshed when next viewed.
 * @returns {Promise<any[]>}
 */
async function bundledTiles() {
  try {
    const res = await fetch('./overpass-seed.json');
    const data = res.ok ? await res.json() : null;
    return Array.isArray(data?.tiles) ? data.tiles : [];
  } catch {
    return [];
  }
}

/** @returns {any[]|null} */
function savedTiles() {
  try {
    const text = localStorage.getItem(TILES_KEY);
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

const initialTiles = savedTiles() ?? (await bundledTiles());

/** @type {import('./src/cameras/overpass.js').TileStore} */
const tileStore = {
  load: () => initialTiles,
  save(tiles) {
    const newest = tiles.length > MAX_STORED_TILES ? [...tiles].sort((a, b) => b.fetchedAt - a.fetchedAt).slice(0, MAX_STORED_TILES) : tiles;
    try {
      localStorage.setItem(TILES_KEY, JSON.stringify(newest));
    } catch {
      // quota full: the in-memory cache still works for this session
    }
  },
};

/**
 * Native HTTP (CapacitorHttp) may not honor AbortSignal, so enforce it here too.
 * @type {typeof fetch}
 */
const deviceFetch = (input, init) => {
  const signal = init?.signal;
  const request = fetch(input, init);
  if (!signal) return request;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    request.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
};

const api = createApi({
  cameraSource: new OverpassCameraSource({ fetch: deviceFetch, endpoints: OVERPASS_ENDPOINTS, store: tileStore }),
  router: new ValhallaRouter({ fetch: deviceFetch }),
  geocoder: new NominatimGeocoder({ fetch: deviceFetch }),
});

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
      return api.config();
    case 'GET /api/cameras':
      return api.cameras(q.get('bbox'));
    case 'GET /api/geocode':
      return api.geocode(q.get('q'), q.get('near'));
    case 'POST /api/route':
      return api.route(JSON.parse(String(init.body ?? '{}')));
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
