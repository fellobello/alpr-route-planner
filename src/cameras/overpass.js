// @ts-check
/**
 * Camera locations from OpenStreetMap via the Overpass API. INTERFACE FILE: exported names,
 * signatures and documented behavior are fixed; the cameras module's builder fills in bodies.
 *
 * Data is (c) OpenStreetMap contributors, ODbL. The UI shows that attribution.
 * Overpass fair use: keep queries small and cached, send USER_AGENT.
 */
import { CAMERA_CACHE_TTL_MS, USER_AGENT, InputError, UpstreamError } from '../types.js';
import { assertBbox, cleanString, isFiniteNumber, selectInBbox } from './common.js';

/** @typedef {import('../types.js').BBox} BBox */
/** @typedef {import('../types.js').Camera} Camera */
/** @typedef {import('../types.js').CameraSource} CameraSource */

export const OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter';

/** Cache tile size in degrees. Bboxes are split on this grid (aligned to multiples of it). */
export const TILE_DEG = 0.1;

/** Server-side query timeout, seconds (the `[timeout:N]` setting). */
const QUERY_TIMEOUT_S = 25;
/** Client-side limit for one HTTP request, a bit longer than the server-side timeout. */
const REQUEST_TIMEOUT_MS = 40_000;
/**
 * Largest bbox width or height getCameras accepts, in degrees. The API caps map requests at
 * MAX_BBOX_SPAN_DEG; this only guards against runaway planner corridors (3 degrees ~ 330 km).
 */
const MAX_QUERY_SPAN_DEG = 3;

/** 16-point compass directions, degrees clockwise from north. */
const COMPASS = Object.freeze({
  N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5,
  S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5,
});

/**
 * Overpass QL selecting every node tagged surveillance:type=ALPR inside the bbox.
 * Must start with `[out:json]`, include a `[timeout:N]` setting, use the bbox in
 * Overpass order (south,west,north,east) and end with `out body;`.
 * @param {BBox} bbox
 * @returns {string}
 */
export function buildOverpassQuery(bbox) {
  assertBbox(bbox);
  const { south, west, north, east } = bbox;
  return (
    `[out:json][timeout:${QUERY_TIMEOUT_S}];\n` +
    `node["surveillance:type"="ALPR"](${south},${west},${north},${east});\n` +
    'out body;'
  );
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
  const elements =
    json && typeof json === 'object' ? /** @type {{elements?: unknown}} */ (json).elements : undefined;
  if (!Array.isArray(elements)) {
    throw new UpstreamError('overpass', 'response has no elements array');
  }
  /** @type {Camera[]} */
  const cameras = [];
  for (const el of elements) {
    if (!el || typeof el !== 'object' || el.type !== 'node') continue;
    if (!isFiniteNumber(el.lat) || !isFiniteNumber(el.lon)) continue;
    const id = osmId(el.id);
    if (id === null) continue;
    const tags = el.tags && typeof el.tags === 'object' ? el.tags : {};
    if (tags['surveillance:type'] !== 'ALPR') continue;
    const manufacturer = cleanString(tags.manufacturer);
    const brand = cleanString(tags.brand);
    cameras.push({
      id: `osm:node/${id}`,
      lat: el.lat,
      lon: el.lon,
      isFlock: /flock/i.test(manufacturer ?? '') || /flock/i.test(brand ?? ''),
      manufacturer,
      operator: cleanString(tags.operator),
      direction: parseDirection(tags.direction) ?? parseDirection(tags['camera:direction']),
      source: 'osm',
    });
  }
  return cameras;
}

/**
 * An OSM element id as a string of digits, or null when it is missing or junk.
 * @param {unknown} v
 * @returns {string|null}
 */
function osmId(v) {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v > 0) return String(v);
  if (typeof v === 'string' && /^[1-9]\d*$/.test(v)) return v;
  return null;
}

/**
 * First usable direction in an OSM direction value, normalized to [0, 360).
 * Values are split on ";"; each part is tried as a compass point ("NE"), then as the first
 * number in it ("90", "45-135" -> 45).
 * @param {unknown} value
 * @returns {number|null}
 */
function parseDirection(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? normalizeDeg(value) : null;
  if (typeof value !== 'string') return null;
  for (const raw of value.split(';')) {
    const part = raw.trim().toUpperCase();
    if (part === '') continue;
    if (Object.hasOwn(COMPASS, part)) return COMPASS[/** @type {keyof typeof COMPASS} */ (part)];
    const m = part.match(/-?\d+(?:\.\d+)?/);
    if (m) return normalizeDeg(Number(m[0]));
  }
  return null;
}

/** @param {number} deg */
function normalizeDeg(deg) {
  const d = ((deg % 360) + 360) % 360;
  return d === 0 ? 0 : d; // no -0
}

// ---- Tile grid ----

/**
 * v / TILE_DEG, snapped to the integer when floating-point error puts it a hair off
 * (33.8 / 0.1 is 337.99999999999994).
 * @param {number} v
 */
function gridUnits(v) {
  const x = v / TILE_DEG;
  const r = Math.round(x);
  return Math.abs(x - r) < 1e-9 ? r : x;
}

/**
 * Tile indices [first, last] covering [lo, hi] on one axis. A value exactly on a grid line
 * belongs to the tile below it (tiles are inclusive on both edges), except a zero-width
 * range sitting on a grid line, which gets the tile above.
 * @param {number} lo
 * @param {number} hi
 * @returns {[number, number]}
 */
function tileRange(lo, hi) {
  const first = Math.floor(gridUnits(lo));
  const last = Math.max(first, Math.ceil(gridUnits(hi)) - 1);
  return [first, last];
}

/**
 * Grid line i in degrees, rounded so -844 * 0.1 is exactly -84.4.
 * @param {number} i
 */
function gridLine(i) {
  return Math.round(i * TILE_DEG * 1e9) / 1e9;
}

/**
 * @typedef {Object} Tile
 * @property {string} key
 * @property {number} row   latitude index
 * @property {number} col   longitude index
 */

/**
 * @param {number} row
 * @param {number} col
 * @returns {BBox}
 */
function tileBbox(row, col) {
  return { south: gridLine(row), west: gridLine(col), north: gridLine(row + 1), east: gridLine(col + 1) };
}

/**
 * @typedef {Object} CacheEntry
 * @property {Promise<Camera[]>} cameras  resolves to the tile's cameras
 * @property {boolean} pending            true while the request is in flight
 * @property {number} fetchedAt           clock reading when the request started
 */

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
    /** @type {Map<string, CacheEntry>} tile key -> entry */
    this._tiles = new Map();
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
    // Implementation notes (not part of the interface):
    // - All missing tiles of one call are fetched with a single query covering their bounding
    //   rectangle: one request instead of one per tile, per Overpass fair use.
    // - A tile already being fetched by an earlier call is awaited, not requested again.
    // - Rejects with InputError for an invalid bbox, or one wider or taller than
    //   MAX_QUERY_SPAN_DEG (callers never send that; it guards Overpass from runaway queries).
    assertBbox(bbox);
    if (bbox.north - bbox.south > MAX_QUERY_SPAN_DEG || bbox.east - bbox.west > MAX_QUERY_SPAN_DEG) {
      throw new InputError(`bbox is too large for Overpass (max ${MAX_QUERY_SPAN_DEG} degrees per side)`);
    }
    const now = this.now();
    const [row0, row1] = tileRange(bbox.south, bbox.north);
    const [col0, col1] = tileRange(bbox.west, bbox.east);
    /** @type {Tile[]} */
    const tiles = [];
    for (let row = row0; row <= row1; row++) {
      for (let col = col0; col <= col1; col++) tiles.push({ key: `${row},${col}`, row, col });
    }
    const missing = tiles.filter((t) => !this._isFresh(this._tiles.get(t.key), now));
    if (missing.length > 0) this._startFetch(missing, now);
    // Every tile has an entry now (fresh, in flight, or just started); read them synchronously.
    const perTile = await Promise.all(
      tiles.map((t) => /** @type {CacheEntry} */ (this._tiles.get(t.key)).cameras),
    );
    return selectInBbox(perTile.flat(), bbox);
  }

  /**
   * @param {CacheEntry|undefined} entry
   * @param {number} now
   */
  _isFresh(entry, now) {
    return entry !== undefined && (entry.pending || now - entry.fetchedAt < this.ttlMs);
  }

  /**
   * Start one request for the given tiles and put an in-flight entry for each in the cache.
   * On failure the entries are removed again, so failed tiles are not cached.
   * @param {Tile[]} tiles
   * @param {number} now
   */
  _startFetch(tiles, now) {
    this._evictExpired(now);
    const batch = this._fetchTiles(tiles);
    /** @type {Map<string, CacheEntry>} */
    const created = new Map();
    for (const tile of tiles) {
      /** @type {CacheEntry} */
      const entry = {
        cameras: batch.then((byTile) => byTile.get(tile.key) ?? []),
        pending: true,
        fetchedAt: now,
      };
      this._tiles.set(tile.key, entry);
      created.set(tile.key, entry);
    }
    batch.then(
      () => {
        for (const entry of created.values()) entry.pending = false;
      },
      () => {
        for (const [key, entry] of created) {
          if (this._tiles.get(key) === entry) this._tiles.delete(key);
        }
      },
    );
  }

  /**
   * Drop finished entries older than the TTL so the cache doesn't grow without bound.
   * @param {number} now
   */
  _evictExpired(now) {
    for (const [key, entry] of this._tiles) {
      if (!entry.pending && now - entry.fetchedAt >= this.ttlMs) this._tiles.delete(key);
    }
  }

  /**
   * One Overpass request for the bounding rectangle of the given tiles; resolves to each
   * tile's cameras (edges inclusive, so a camera on a grid line lands in both tiles).
   * @param {Tile[]} tiles
   * @returns {Promise<Map<string, Camera[]>>}
   */
  async _fetchTiles(tiles) {
    const rows = tiles.map((t) => t.row);
    const cols = tiles.map((t) => t.col);
    // Clamped so a bbox touching the poles or the antimeridian still gives a valid query.
    const rect = {
      south: Math.max(-90, gridLine(Math.min(...rows))),
      west: Math.max(-180, gridLine(Math.min(...cols))),
      north: Math.min(90, gridLine(Math.max(...rows) + 1)),
      east: Math.min(180, gridLine(Math.max(...cols) + 1)),
    };
    const cameras = await this._query(buildOverpassQuery(rect));
    /** @type {Map<string, Camera[]>} */
    const byTile = new Map();
    for (const tile of tiles) {
      const tb = tileBbox(tile.row, tile.col);
      byTile.set(
        tile.key,
        cameras.filter((c) => c.lat >= tb.south && c.lat <= tb.north && c.lon >= tb.west && c.lon <= tb.east),
      );
    }
    return byTile;
  }

  /**
   * POST a query to Overpass and parse the answer.
   * @param {string} query
   * @returns {Promise<Camera[]>}
   */
  async _query(query) {
    const doFetch = this.fetch;
    if (typeof doFetch !== 'function') throw new UpstreamError('overpass', 'no fetch function available');
    /** @type {Response} */
    let res;
    try {
      res = await doFetch(this.endpoint, {
        method: 'POST',
        headers: {
          'User-Agent': this.userAgent,
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          Accept: 'application/json',
        },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      if (err instanceof UpstreamError) throw err;
      const e = /** @type {{name?: string, message?: string}} */ (err ?? {});
      const reason = e.name === 'TimeoutError' || e.name === 'AbortError' ? 'request timed out' : `request failed: ${e.message ?? String(err)}`;
      throw new UpstreamError('overpass', reason);
    }
    if (!res || typeof res !== 'object') throw new UpstreamError('overpass', 'no response');
    const ok = typeof res.ok === 'boolean' ? res.ok : res.status >= 200 && res.status < 300;
    if (!ok) {
      const status = `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`;
      throw new UpstreamError('overpass', res.status === 429 ? `rate limited (${status})` : status);
    }
    /** @type {unknown} */
    let json;
    try {
      json = typeof res.json === 'function' ? await res.json() : JSON.parse(await res.text());
    } catch {
      throw new UpstreamError('overpass', 'response is not valid JSON');
    }
    // Overpass reports query timeouts and memory limits with HTTP 200 and a "runtime error"
    // remark, sometimes with partial elements. Treat that as a failure so it isn't cached.
    const remark = json && typeof json === 'object' ? /** @type {{remark?: unknown}} */ (json).remark : undefined;
    if (typeof remark === 'string' && /runtime error/i.test(remark)) {
      throw new UpstreamError('overpass', remark.trim());
    }
    return parseOverpass(json);
  }
}
