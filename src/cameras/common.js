// @ts-check
/**
 * Small helpers shared by the camera sources. Internal to the cameras module (not an interface).
 */
import { InputError } from '../types.js';

/** @typedef {import('../types.js').BBox} BBox */
/** @typedef {import('../types.js').Camera} Camera */

/**
 * @param {unknown} v
 * @returns {v is number}
 */
export function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * A trimmed non-empty string, or null.
 * @param {unknown} v
 * @returns {string|null}
 */
export function cleanString(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s === '' ? null : s;
}

/**
 * Throw InputError unless bbox has finite south/west/north/east in range with south <= north
 * and west <= east.
 * @param {unknown} bbox
 * @returns {asserts bbox is BBox}
 */
export function assertBbox(bbox) {
  if (!bbox || typeof bbox !== 'object') throw new InputError('bbox must be an object {south, west, north, east}');
  const b = /** @type {Record<string, unknown>} */ (bbox);
  for (const k of ['south', 'west', 'north', 'east']) {
    if (!isFiniteNumber(b[k])) throw new InputError(`bbox.${k} must be a finite number`);
  }
  const { south, west, north, east } = /** @type {BBox} */ (bbox);
  if (south < -90 || north > 90) throw new InputError('bbox latitudes must be between -90 and 90');
  if (west < -180 || east > 180) throw new InputError('bbox longitudes must be between -180 and 180');
  if (south > north) throw new InputError('bbox south must not be greater than north');
  if (west > east) throw new InputError('bbox west must not be greater than east');
}

/**
 * Whether a point is inside the bbox, edges included.
 * @param {BBox} bbox
 * @param {{lat: number, lon: number}} p
 */
export function inBbox(bbox, p) {
  return p.lat >= bbox.south && p.lat <= bbox.north && p.lon >= bbox.west && p.lon <= bbox.east;
}

/**
 * Cameras inside the bbox, each id once (first wins), as shallow copies so callers can't
 * change a source's stored data.
 * @param {Iterable<Camera>} cameras
 * @param {BBox} bbox
 * @returns {Camera[]}
 */
export function selectInBbox(cameras, bbox) {
  const seen = new Set();
  /** @type {Camera[]} */
  const out = [];
  for (const c of cameras) {
    if (seen.has(c.id) || !inBbox(bbox, c)) continue;
    seen.add(c.id);
    out.push({ ...c });
  }
  return out;
}
