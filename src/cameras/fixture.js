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
import { NotImplementedError } from '../types.js';

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
  throw new NotImplementedError('cameras.loadSampleCameras');
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
    throw new NotImplementedError('cameras.FixtureCameraSource.getCameras');
  }
}
