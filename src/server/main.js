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
import { NotImplementedError } from '../types.js';

/**
 * Pick the CameraSource and Router named by env (see above).
 * @param {Record<string, string|undefined>} env
 * @returns {{cameraSource: import('../types.js').CameraSource, router: import('../types.js').Router, host: string, port: number}}
 */
export function configFromEnv(env) {
  throw new NotImplementedError('api.configFromEnv');
}

/** Start the server. */
export async function main() {
  throw new NotImplementedError('api.main');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
