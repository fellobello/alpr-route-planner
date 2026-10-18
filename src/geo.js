// @ts-check
/**
 * Pure geometry helpers. INTERFACE FILE: signatures and documented behavior are fixed;
 * the geo module's builder replaces the bodies. No I/O, no dependencies.
 *
 * Accuracy target: within 1% of true distance for spans under 100 km
 * (an equirectangular projection around the segment is fine for point-to-line distances).
 */
import { NotImplementedError } from './types.js';

/** @typedef {import('./types.js').LatLng} LatLng */
/** @typedef {import('./types.js').LatLonPair} LatLonPair */
/** @typedef {import('./types.js').BBox} BBox */
/** @typedef {import('./types.js').Camera} Camera */

/** Mean Earth radius used by every function here. */
export const EARTH_RADIUS_M = 6_371_008.8;

/**
 * Great-circle distance between two points.
 * @param {LatLng} a
 * @param {LatLng} b
 * @returns {number} meters
 */
export function haversineM(a, b) {
  throw new NotImplementedError('geo.haversineM');
}

/**
 * Total length of a line (sum of haversine segment lengths). 0 for fewer than 2 points.
 * @param {LatLonPair[]} line
 * @returns {number} meters
 */
export function lineLengthM(line) {
  throw new NotImplementedError('geo.lineLengthM');
}

/**
 * Shortest distance from a point to a line (to any segment, not just vertices).
 * A 1-point line is treated as that point. Throws InputError for an empty line.
 * @param {LatLng} p
 * @param {LatLonPair[]} line
 * @returns {number} meters
 */
export function pointToPolylineM(p, line) {
  throw new NotImplementedError('geo.pointToPolylineM');
}

/**
 * Distance along the line, from its first point, to the point on the line nearest p.
 * Used to order cameras along a route.
 * @param {LatLng} p
 * @param {LatLonPair[]} line
 * @returns {number} meters, between 0 and lineLengthM(line)
 */
export function positionAlongM(p, line) {
  throw new NotImplementedError('geo.positionAlongM');
}

/**
 * Cameras whose distance to the line is <= bufferM, ordered by positionAlongM
 * (ties broken by id). Does not mutate the input.
 * @param {Camera[]} cameras
 * @param {LatLonPair[]} line
 * @param {number} bufferM
 * @returns {Camera[]}
 */
export function camerasNearRoute(cameras, line, bufferM) {
  throw new NotImplementedError('geo.camerasNearRoute');
}

/**
 * Smallest bbox containing every point, grown by marginM on all four sides,
 * clamped to lat [-90, 90] and lon [-180, 180]. Throws InputError for no points.
 * @param {(LatLng|LatLonPair)[]} points  objects or [lat, lon] pairs, may be mixed
 * @param {number} marginM
 * @returns {BBox}
 */
export function bboxAround(points, marginM) {
  throw new NotImplementedError('geo.bboxAround');
}

/**
 * True when the point is inside the bbox (edges inclusive).
 * @param {BBox} bbox
 * @param {LatLng} p
 * @returns {boolean}
 */
export function bboxContains(bbox, p) {
  throw new NotImplementedError('geo.bboxContains');
}

/**
 * Smallest bbox containing both.
 * @param {BBox} a
 * @param {BBox} b
 * @returns {BBox}
 */
export function bboxUnion(a, b) {
  throw new NotImplementedError('geo.bboxUnion');
}

/**
 * Closed polygon ring approximating a circle, in [lon, lat] order (Valhalla/GeoJSON order).
 * Returns sides + 1 positions; the last equals the first.
 * @param {LatLng} center
 * @param {number} radiusM
 * @param {number} [sides=12]
 * @returns {[number, number][]}
 */
export function circleRing(center, radiusM, sides = 12) {
  throw new NotImplementedError('geo.circleRing');
}

/**
 * Decode a Google-style encoded polyline (Valhalla uses precision 6).
 * @param {string} encoded
 * @param {number} [precision=6]
 * @returns {LatLonPair[]}
 */
export function decodePolyline(encoded, precision = 6) {
  throw new NotImplementedError('geo.decodePolyline');
}

/**
 * Inverse of decodePolyline: decodePolyline(encodePolyline(x, p), p) equals x rounded to p decimals.
 * @param {LatLonPair[]} points
 * @param {number} [precision=6]
 * @returns {string}
 */
export function encodePolyline(points, precision = 6) {
  throw new NotImplementedError('geo.encodePolyline');
}
