// @ts-check
/**
 * Place search through OpenStreetMap's Nominatim. Follows its usage policy: an identifying
 * User-Agent, at most one request per second, results cached, and no search-as-you-type
 * (the browser only searches when the user submits).
 */
import { GEOCODE_LIMIT, USER_AGENT, UpstreamError } from '../types.js';

/** @typedef {import('../types.js').LatLng} LatLng */
/** @typedef {import('../types.js').Place} Place */

export const NOMINATIM_ENDPOINT = 'https://nominatim.openstreetmap.org/search';

/** Smallest gap between two requests, per the usage policy (1 per second, with slack). */
export const MIN_INTERVAL_MS = 1100;

/** Half-size of the box results are biased toward when the caller says where the map is. */
const NEAR_DEG = 0.5;

/** Cached searches kept, oldest dropped first. */
const CACHE_SIZE = 200;

/**
 * Query string for one search.
 * @param {string} query
 * @param {LatLng|null} [near]  bias results toward this point (not a hard limit)
 * @returns {string}
 */
export function buildNominatimUrl(query, near) {
  const params = new URLSearchParams({ q: query, format: 'jsonv2', limit: String(GEOCODE_LIMIT) });
  if (near) {
    const box = [near.lon - NEAR_DEG, near.lat + NEAR_DEG, near.lon + NEAR_DEG, near.lat - NEAR_DEG];
    params.set('viewbox', box.map((x) => x.toFixed(4)).join(','));
  }
  return `${NOMINATIM_ENDPOINT}?${params}`;
}

/**
 * Nominatim jsonv2 results as Places. Entries without usable coordinates are skipped.
 * @param {unknown} json
 * @returns {Place[]}
 */
export function parseNominatim(json) {
  if (!Array.isArray(json)) throw new UpstreamError('nominatim', 'expected a JSON array');
  /** @type {Place[]} */
  const out = [];
  for (const item of json) {
    if (!item || typeof item !== 'object') continue;
    const lat = Number(item.lat);
    const lon = Number(item.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const display = typeof item.display_name === 'string' ? item.display_name : '';
    const parts = display.split(',').map((s) => s.trim()).filter(Boolean);
    const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : parts[0] || display;
    const rest = parts[0] === name ? parts.slice(1) : parts;
    out.push({ name, detail: rest.join(', '), lat, lon });
    if (out.length === GEOCODE_LIMIT) break;
  }
  return out;
}

/** @implements {import('../types.js').Geocoder} */
export class NominatimGeocoder {
  /**
   * @param {Object} [opts]
   * @param {typeof fetch} [opts.fetch=globalThis.fetch]  injected so tests never touch the network
   * @param {string} [opts.userAgent=USER_AGENT]
   * @param {() => number} [opts.now=Date.now]
   * @param {(ms: number) => Promise<void>} [opts.sleep]  injected so tests do not wait
   */
  constructor(opts = {}) {
    this.name = 'nominatim';
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.userAgent = opts.userAgent ?? USER_AGENT;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    /** @type {Map<string, Promise<Place[]>>} */
    this._cache = new Map();
    /** Requests run one at a time; each waits for the one before it. */
    this._queue = Promise.resolve();
    this._lastAt = -Infinity;
  }

  /**
   * @param {string} query
   * @param {LatLng|null} [near]
   * @returns {Promise<Place[]>}
   */
  search(query, near = null) {
    // Round the bias point so small pans reuse the cache.
    const nearKey = near ? { lat: Math.round(near.lat * 10) / 10, lon: Math.round(near.lon * 10) / 10 } : null;
    const url = buildNominatimUrl(query.trim(), nearKey);
    const hit = this._cache.get(url);
    if (hit) return hit;

    const result = this._queue.then(() => this._request(url));
    this._queue = result.then(
      () => undefined,
      () => undefined,
    );
    this._cache.set(url, result);
    if (this._cache.size > CACHE_SIZE) this._cache.delete(/** @type {string} */ (this._cache.keys().next().value));
    result.catch(() => this._cache.delete(url)); // failures are not cached
    return result;
  }

  /** @param {string} url */
  async _request(url) {
    const wait = this._lastAt + MIN_INTERVAL_MS - this.now();
    if (wait > 0) await this.sleep(wait);
    this._lastAt = this.now();

    let res;
    try {
      res = await this.fetch(url, { headers: { Accept: 'application/json', 'User-Agent': this.userAgent } });
    } catch (err) {
      throw new UpstreamError('nominatim', `request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) throw new UpstreamError('nominatim', `HTTP ${res.status}`);
    let json;
    try {
      json = await res.json();
    } catch {
      throw new UpstreamError('nominatim', 'response is not JSON');
    }
    return parseNominatim(json);
  }
}
