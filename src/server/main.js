// @ts-check
/**
 * Entry point: `npm start` (live data) or `npm run offline` (sample cameras + stub router).
 * INTERFACE FILE for its environment variables; the api module's builder implements it.
 *
 * Environment:
 *   PORT           default 8080
 *   HOST           default 127.0.0.1
 *   CAMERA_SOURCE  "overpass" (default) | "fixture"
 *   ROUTER         "valhalla" (default) | "stub"
 *   GEOCODER       "nominatim" (default) | "none" (search then only reads typed "lat, lon")
 *   OFFLINE=1      same as CAMERA_SOURCE=fixture ROUTER=stub GEOCODER=none
 *   CONTACT        email or URL added to the User-Agent sent to Overpass and Valhalla
 *   CACHE_FILE     where Overpass tiles are kept between runs (default data/cache/overpass-tiles.json);
 *                  "off" keeps them in memory only
 * Unknown CAMERA_SOURCE / ROUTER values exit with code 1 and a message.
 * On start it prints: "ALPR Route Planner on http://<host>:<port> (cameras: <name>, router: <name>)".
 * SIGINT / SIGTERM close the server, letting requests in flight finish.
 */
import { pathToFileURL } from 'node:url';
import { APP_TITLE, InputError, USER_AGENT } from '../types.js';
import { OVERPASS_ENDPOINTS, OverpassCameraSource } from '../cameras/overpass.js';
import { DEFAULT_CACHE_FILE, FileTileStore } from '../cameras/tile-store.js';
import { FixtureCameraSource } from '../cameras/fixture.js';
import { ValhallaRouter } from '../routing/valhalla.js';
import { StubRouter } from '../routing/stub.js';
import { NominatimGeocoder } from '../geocode/nominatim.js';
import { createServer } from './app.js';

const DEFAULT_PORT = 8080;
const DEFAULT_HOST = '127.0.0.1';

/** @type {Record<string, (userAgent: string, env: Record<string, string|undefined>) => import('../types.js').CameraSource>} */
const CAMERA_SOURCES = {
  overpass: (userAgent, env) => new OverpassCameraSource({ userAgent, endpoints: OVERPASS_ENDPOINTS, store: tileStore(env) }),
  fixture: () => new FixtureCameraSource(),
};

/**
 * @param {Record<string, string|undefined>} env
 * @returns {FileTileStore|null}
 */
function tileStore(env) {
  const file = env.CACHE_FILE?.trim();
  if (file && OFF_VALUES.has(file.toLowerCase())) return null;
  return new FileTileStore(file || DEFAULT_CACHE_FILE);
}

/** @type {Record<string, (userAgent: string) => import('../types.js').Router>} */
const ROUTERS = {
  valhalla: (userAgent) => new ValhallaRouter({ userAgent }),
  stub: () => new StubRouter(),
};

/** @type {Record<string, (userAgent: string) => import('../types.js').Geocoder|null>} */
const GEOCODERS = {
  nominatim: (userAgent) => new NominatimGeocoder({ userAgent }),
  none: () => null,
};

/** OFFLINE values that mean "off"; any other non-empty value turns offline mode on. */
const OFF_VALUES = new Set(['0', 'false', 'no', 'off']);

/**
 * Pick the CameraSource and Router named by env (see above).
 * @param {Record<string, string|undefined>} env
 * @returns {{cameraSource: import('../types.js').CameraSource, router: import('../types.js').Router, geocoder: import('../types.js').Geocoder|null, host: string, port: number}}
 */
export function configFromEnv(env) {
  const offline = isOn(env.OFFLINE);
  const sourceName = offline ? 'fixture' : pick(env.CAMERA_SOURCE, 'overpass', 'CAMERA_SOURCE', CAMERA_SOURCES);
  const routerName = offline ? 'stub' : pick(env.ROUTER, 'valhalla', 'ROUTER', ROUTERS);
  const geocoderName = offline ? 'none' : pick(env.GEOCODER, 'nominatim', 'GEOCODER', GEOCODERS);
  const port = parsePort(env.PORT);
  const host = env.HOST?.trim() || DEFAULT_HOST;
  const userAgent = userAgentFor(env.CONTACT);
  return {
    cameraSource: CAMERA_SOURCES[sourceName](userAgent, env),
    router: ROUTERS[routerName](userAgent),
    geocoder: GEOCODERS[geocoderName](userAgent),
    host,
    port,
  };
}

/**
 * Start the server. Resolves to the listening server, or to undefined after printing a
 * message and setting process.exitCode = 1 when the environment is invalid or the port is taken.
 * @returns {Promise<import('node:http').Server | undefined>}
 */
export async function main() {
  let config;
  try {
    config = configFromEnv(process.env);
  } catch (err) {
    if (err instanceof InputError) {
      console.error(`Error: ${err.message}`);
      process.exitCode = 1;
      return undefined;
    }
    throw err;
  }
  const { cameraSource, router, geocoder, host, port } = config;
  const server = createServer({ cameraSource, router, geocoder });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve(undefined);
      });
    });
  } catch (err) {
    const code = /** @type {{code?: string}} */ (err).code;
    if (code === 'EADDRINUSE' || code === 'EACCES' || code === 'EADDRNOTAVAIL') {
      const why = code === 'EADDRINUSE' ? 'is already in use' : code === 'EACCES' ? 'needs more permissions' : 'is not available';
      console.error(`Error: ${host}:${port} ${why}. Set PORT or HOST to use another address.`);
      process.exitCode = 1;
      return undefined;
    }
    throw err;
  }
  const address = server.address();
  const boundPort = address && typeof address === 'object' ? address.port : port;
  console.log(
    `${APP_TITLE} on http://${urlHost(host)}:${boundPort} (cameras: ${cameraSource.name}, router: ${router.name})`,
  );
  return server;
}

/**
 * @param {string|undefined} value
 * @returns {boolean}
 */
function isOn(value) {
  const v = value?.trim().toLowerCase();
  return Boolean(v) && !OFF_VALUES.has(/** @type {string} */ (v));
}

/**
 * @param {string|undefined} value
 * @param {string} fallback
 * @param {string} varName
 * @param {Record<string, unknown>} known
 * @returns {string}
 */
function pick(value, fallback, varName, known) {
  const name = value?.trim().toLowerCase() || fallback;
  if (!Object.hasOwn(known, name)) {
    const choices = Object.keys(known).map((k) => `"${k}"`).join(' or ');
    throw new InputError(`Unknown ${varName} "${value}". Use ${choices}.`);
  }
  return name;
}

/**
 * @param {string|undefined} value
 * @returns {number}
 */
function parsePort(value) {
  const text = value?.trim();
  if (!text) return DEFAULT_PORT;
  const port = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isInteger(port) || port > 65535) {
    throw new InputError(`PORT must be a whole number from 0 to 65535, got "${value}".`);
  }
  return port;
}

/**
 * USER_AGENT with CONTACT in the parentheses. Without CONTACT, USER_AGENT as types.js built it.
 * @param {string|undefined} contact
 * @returns {string}
 */
function userAgentFor(contact) {
  const c = contact?.trim();
  if (!c) return USER_AGENT;
  if (!/^[\x20-\x7e]+$/.test(c)) {
    throw new InputError('CONTACT must be plain ASCII text, such as an email address or URL.');
  }
  const cut = USER_AGENT.indexOf(' (');
  const product = cut === -1 ? USER_AGENT : USER_AGENT.slice(0, cut);
  return `${product} (${c})`;
}

/**
 * Bracket IPv6 literals so the printed URL is clickable.
 * @param {string} host
 */
function urlHost(host) {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

/**
 * Close the server on SIGINT / SIGTERM (Ctrl-C, `docker stop`); a second signal exits at once.
 * @param {import('node:http').Server} server
 * @param {() => void} onClose  last chance to save state
 */
function closeOnSignals(server, onClose) {
  let closing = false;
  const stop = (/** @type {string} */ signal) => {
    if (closing) process.exit(1);
    closing = true;
    console.log(`${signal}: shutting down`);
    onClose();
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((server) => server && closeOnSignals(server, () => FileTileStore.flushAll()))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
