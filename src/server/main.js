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
 *   OFFLINE=1      same as CAMERA_SOURCE=fixture ROUTER=stub
 *   CONTACT        email or URL added to the User-Agent sent to Overpass and Valhalla
 * Unknown CAMERA_SOURCE / ROUTER values exit with code 1 and a message.
 * On start it prints: "ALPR Route Planner on http://<host>:<port> (cameras: <name>, router: <name>)".
 */
import { pathToFileURL } from 'node:url';
import { APP_TITLE, InputError, USER_AGENT } from '../types.js';
import { OverpassCameraSource } from '../cameras/overpass.js';
import { FixtureCameraSource } from '../cameras/fixture.js';
import { ValhallaRouter } from '../routing/valhalla.js';
import { StubRouter } from '../routing/stub.js';
import { createServer } from './app.js';

const DEFAULT_PORT = 8080;
const DEFAULT_HOST = '127.0.0.1';

/** @type {Record<string, (userAgent: string) => import('../types.js').CameraSource>} */
const CAMERA_SOURCES = {
  overpass: (userAgent) => new OverpassCameraSource({ userAgent }),
  fixture: () => new FixtureCameraSource(),
};

/** @type {Record<string, (userAgent: string) => import('../types.js').Router>} */
const ROUTERS = {
  valhalla: (userAgent) => new ValhallaRouter({ userAgent }),
  stub: () => new StubRouter(),
};

/** OFFLINE values that mean "off"; any other non-empty value turns offline mode on. */
const OFF_VALUES = new Set(['0', 'false', 'no', 'off']);

/**
 * Pick the CameraSource and Router named by env (see above).
 * @param {Record<string, string|undefined>} env
 * @returns {{cameraSource: import('../types.js').CameraSource, router: import('../types.js').Router, host: string, port: number}}
 */
export function configFromEnv(env) {
  const offline = isOn(env.OFFLINE);
  const sourceName = offline ? 'fixture' : pick(env.CAMERA_SOURCE, 'overpass', 'CAMERA_SOURCE', CAMERA_SOURCES);
  const routerName = offline ? 'stub' : pick(env.ROUTER, 'valhalla', 'ROUTER', ROUTERS);
  const port = parsePort(env.PORT);
  const host = env.HOST?.trim() || DEFAULT_HOST;
  const userAgent = userAgentFor(env.CONTACT);
  return {
    cameraSource: CAMERA_SOURCES[sourceName](userAgent),
    router: ROUTERS[routerName](userAgent),
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
  const { cameraSource, router, host, port } = config;
  const server = createServer({ cameraSource, router });
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
