// @ts-check
/**
 * Offline camera source backed by a JSON file. INTERFACE FILE: exported names, signatures and
 * documented behavior are fixed; the cameras module's builder fills in bodies and writes
 * data/sample-cameras.json.
 *
 * data/sample-cameras.json schema:
 *   { "note": "Made-up cameras for offline demos. Not real locations.",
 *     "cameras": Camera[] }   // 20-40 entries, ids "sample:<n>", source "sample",
 *                             // spread over central Atlanta (lat 33.70-33.80, lon -84.45 to -84.33),
 *                             // mostly on major roads, about a third with isFlock true.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { InputError } from '../types.js';
import { assertBbox, cleanString, isFiniteNumber, selectInBbox } from './common.js';

/** @typedef {import('../types.js').BBox} BBox */
/** @typedef {import('../types.js').Camera} Camera */
/** @typedef {import('../types.js').CameraSource} CameraSource */

export const SAMPLE_CAMERAS_PATH = new URL('../../data/sample-cameras.json', import.meta.url);

/**
 * Read and validate a sample camera file (synchronously). Throws InputError when the file
 * is missing a cameras array or a camera lacks a string id or numeric lat/lon.
 * @param {string|URL} [path=SAMPLE_CAMERAS_PATH]
 * @returns {Camera[]}
 */
export function loadSampleCameras(path = SAMPLE_CAMERAS_PATH) {
  const where = path instanceof URL ? (path.protocol === 'file:' ? fileURLToPath(path) : path.href) : String(path);
  /** @type {string} */
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    const e = /** @type {{code?: string, message?: string}} */ (err ?? {});
    throw new InputError(`cannot read sample camera file ${where}: ${e.code ?? e.message ?? String(err)}`);
  }
  /** @type {unknown} */
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new InputError(`sample camera file ${where} is not valid JSON: ${/** @type {Error} */ (err).message}`);
  }
  const list =
    data && typeof data === 'object' ? /** @type {{cameras?: unknown}} */ (data).cameras : undefined;
  if (!Array.isArray(list)) {
    throw new InputError(`sample camera file ${where} has no "cameras" array`);
  }
  return list.map((raw, i) => toCamera(raw, i, where));
}

/**
 * Validate one camera from a sample file and fill in the optional fields, so every loaded
 * camera has the full Camera shape.
 * @param {unknown} raw
 * @param {number} index
 * @param {string} where  file path, for error messages
 * @returns {Camera}
 */
function toCamera(raw, index, where) {
  const at = `sample camera file ${where}, cameras[${index}]`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new InputError(`${at} is not an object`);
  const c = /** @type {Record<string, unknown>} */ (raw);
  if (typeof c.id !== 'string' || c.id.trim() === '') throw new InputError(`${at} needs a string id`);
  if (!isFiniteNumber(c.lat) || c.lat < -90 || c.lat > 90) {
    throw new InputError(`${at} (${c.id}) needs a numeric lat between -90 and 90`);
  }
  if (!isFiniteNumber(c.lon) || c.lon < -180 || c.lon > 180) {
    throw new InputError(`${at} (${c.id}) needs a numeric lon between -180 and 180`);
  }
  const manufacturer = cleanString(c.manufacturer);
  return {
    id: c.id,
    lat: c.lat,
    lon: c.lon,
    // An explicit boolean wins; without one, use the same rule as OSM data.
    isFlock: typeof c.isFlock === 'boolean' ? c.isFlock : /flock/i.test(manufacturer ?? ''),
    manufacturer,
    operator: cleanString(c.operator),
    direction: isFiniteNumber(c.direction) ? c.direction : null,
    source: c.source === 'osm' ? 'osm' : 'sample',
  };
}

/** @implements {CameraSource} */
export class FixtureCameraSource {
  /**
   * @param {Object} [opts]
   * @param {Camera[]} [opts.cameras]  defaults to loadSampleCameras()
   */
  constructor(opts = {}) {
    this.name = 'fixture';
    /** @type {Camera[] | undefined} */
    this._cameras = opts.cameras;
  }

  /**
   * Cameras inside the bbox (edges inclusive), in file order. Never rejects for a valid bbox.
   * @param {BBox} bbox
   * @returns {Promise<Camera[]>}
   */
  async getCameras(bbox) {
    assertBbox(bbox);
    // Loaded on first use (then kept), so constructing the source never touches the disk.
    if (this._cameras === undefined) this._cameras = loadSampleCameras();
    return selectInBbox(this._cameras, bbox);
  }
}
