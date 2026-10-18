// @ts-check
/**
 * Camera locations from OpenStreetMap via the Overpass API. INTERFACE FILE: exported names,
 * signatures and documented behavior are fixed; the cameras module's builder fills in bodies.
 *
 * Data is (c) OpenStreetMap contributors, ODbL. The UI shows that attribution.
 * Overpass fair use: keep queries small and cached, send USER_AGENT.
 */
import { CAMERA_CACHE_TTL_MS, USER_AGENT, NotImplementedError } from '../types.js';

/** @typedef {import('../types.js').BBox} BBox */
/** @typedef {import('../types.js').Camera} Camera */
/** @typedef {import('../types.js').CameraSource} CameraSource */

export const OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter';

/** Cache tile size in degrees. Bboxes are split on this grid (aligned to multiples of it). */
export const TILE_DEG = 0.1;

/**
 * Overpass QL selecting every node tagged surveillance:type=ALPR inside the bbox.
 * Must start with `[out:json]`, include a `[timeout:N]` setting, use the bbox in
 * Overpass order (south,west,north,east) and end with `out body;`.
 * @param {BBox} bbox
 * @returns {string}
 */
export function buildOverpassQuery(bbox) {
  throw new NotImplementedError('cameras.buildOverpassQuery');
}

/**
 * Convert an Overpass JSON response ({elements: [...]}) to Cameras.
 * Keeps only elements with type "node", numeric lat/lon and tags["surveillance:type"] === "ALPR".
 * id = "osm:node/<id>", source = "osm", isFlock from manufacturer or brand containing "flock"
 * (case-insensitive), direction = first number in tags.direction or tags["camera:direction"]
 * (e.g. "90;270" -> 90; cardinal letters like "NE" -> 45), otherwise null.
 * Throws UpstreamError("overpass", ...) when json has no elements array.
 * @param {unknown} json
 * @returns {Camera[]}
 */
export function parseOverpass(json) {
  throw new NotImplementedError('cameras.parseOverpass');
}

/** @implements {CameraSource} */
export class OverpassCameraSource {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.endpoint=OVERPASS_ENDPOINT]
   * @param {typeof fetch} [opts.fetch=globalThis.fetch]  injected so tests never touch the network
   * @param {number} [opts.ttlMs=CAMERA_CACHE_TTL_MS]
   * @param {string} [opts.userAgent=USER_AGENT]
   * @param {() => number} [opts.now=Date.now]           injected clock for cache tests
   */
  constructor(opts = {}) {
    this.name = 'overpass';
    this.endpoint = opts.endpoint ?? OVERPASS_ENDPOINT;
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.ttlMs = opts.ttlMs ?? CAMERA_CACHE_TTL_MS;
    this.userAgent = opts.userAgent ?? USER_AGENT;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Every ALPR camera in the bbox. Splits the bbox into TILE_DEG tiles, serves fresh tiles
   * from an in-memory cache, fetches the missing ones from Overpass (POST, body
   * "data=<urlencoded query>", User-Agent header), then filters to the bbox and dedupes by id.
   * A second call for the same area within ttlMs makes no request.
   * Rejects with UpstreamError("overpass", ...) on network failure, non-2xx or bad JSON;
   * failed tiles are not cached.
   * @param {BBox} bbox
   * @returns {Promise<Camera[]>}
   */
  async getCameras(bbox) {
    throw new NotImplementedError('cameras.OverpassCameraSource.getCameras');
  }
}
