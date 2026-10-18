// @ts-check
/**
 * Pure geometry helpers. INTERFACE FILE: signatures and documented behavior are fixed;
 * the geo module's builder replaces the bodies. No I/O, no dependencies.
 *
 * Accuracy target: within 1% of true distance for spans under 100 km
 * (an equirectangular projection around the segment is fine for point-to-line distances).
 */
import { InputError } from './types.js';

/** @typedef {import('./types.js').LatLng} LatLng */
/** @typedef {import('./types.js').LatLonPair} LatLonPair */
/** @typedef {import('./types.js').BBox} BBox */
/** @typedef {import('./types.js').Camera} Camera */

/** Mean Earth radius used by every function here. */
export const EARTH_RADIUS_M = 6_371_008.8;

const DEG = Math.PI / 180;
/** Meters per degree of latitude (and of longitude at the equator) on the mean sphere. */
const M_PER_DEG = EARTH_RADIUS_M * DEG;

// ---- internal helpers ----

/**
 * Wrap a longitude difference into [-180, 180) so segments that cross the antimeridian
 * take the short way round.
 * @param {number} d degrees
 */
function wrapDeltaLon(d) {
  if (d >= -180 && d < 180) return d;
  return ((((d + 180) % 360) + 360) % 360) - 180;
}

/**
 * Normalize a longitude into [-180, 180].
 * @param {number} lon degrees
 */
function normalizeLon(lon) {
  if (lon >= -180 && lon <= 180) return lon;
  return wrapDeltaLon(lon);
}

/**
 * @param {unknown} p
 * @param {string} what
 * @returns {LatLng}
 */
function checkLatLng(p, what) {
  const q = /** @type {any} */ (p);
  if (!q || !Number.isFinite(q.lat) || !Number.isFinite(q.lon)) {
    throw new InputError(`${what} must be {lat, lon} with finite numbers`);
  }
  return q;
}

/**
 * @param {unknown} line
 * @returns {LatLonPair[]}
 */
function checkLine(line) {
  if (!Array.isArray(line)) throw new InputError('line must be an array of [lat, lon] pairs');
  return line;
}

/**
 * @param {unknown} pt
 * @param {number} i
 * @returns {LatLonPair}
 */
function checkPair(pt, i) {
  if (!Array.isArray(pt) || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) {
    throw new InputError(`line[${i}] must be [lat, lon] with finite numbers`);
  }
  return /** @type {LatLonPair} */ (pt);
}

/**
 * Haversine on raw degrees (no object allocation).
 * @param {number} lat1 @param {number} lon1 @param {number} lat2 @param {number} lon2
 */
function havDeg(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * DEG;
  const p2 = lat2 * DEG;
  const sdLat = Math.sin((p2 - p1) / 2);
  const sdLon = Math.sin(((lon2 - lon1) * DEG) / 2);
  const h = sdLat * sdLat + Math.cos(p1) * Math.cos(p2) * sdLon * sdLon;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * True when some segment's raw longitude step is over 180 degrees, i.e. it takes the short
 * way across the antimeridian. Also validates every pair (InputError).
 * @param {LatLonPair[]} line
 */
function crossesAntimeridian(line) {
  let crosses = false;
  let prev = line.length > 0 ? checkPair(line[0], 0) : null;
  for (let i = 1; i < line.length; i++) {
    const cur = checkPair(line[i], i);
    if (prev && Math.abs(cur[1] - prev[1]) > 180) crosses = true;
    prev = cur;
  }
  return crosses;
}

/**
 * Segment lengths and cumulative distance to each vertex.
 * @param {LatLonPair[]} line
 * @returns {{seg: number[], cum: number[], total: number}}
 */
function lineMeasure(line) {
  /** @type {number[]} */
  const seg = [];
  /** @type {number[]} */
  const cum = [0];
  let total = 0;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1];
    const b = line[i];
    const d = havDeg(a[0], a[1], b[0], b[1]);
    seg.push(d);
    total += d;
    cum.push(total);
  }
  return { seg, cum, total };
}

/**
 * Nearest point on the line to p. Each segment is projected with a local equirectangular
 * projection centred on p (x scaled by cos of the mean latitude of p and the segment);
 * the winning segment's nearest point is then measured with haversine, so the returned
 * distance is a true great-circle distance to a point on the line.
 * Ties keep the earliest segment.
 * @param {LatLng} p
 * @param {LatLonPair[]} line  non-empty, already validated
 * @returns {{index: number, t: number, distM: number}}
 *   index: segment index (0 for a 1-point line), t: fraction along that segment in [0, 1]
 */
function nearestOnLine(p, line) {
  const first = checkPair(line[0], 0);
  if (line.length === 1) {
    return { index: 0, t: 0, distM: havDeg(p.lat, p.lon, first[0], first[1]) };
  }
  let bestIndex = 0;
  let bestT = 0;
  let bestD2 = Infinity;
  for (let i = 1; i < line.length; i++) {
    const a = i === 1 ? first : line[i - 1];
    const b = checkPair(line[i], i);
    const k = Math.cos(((p.lat + a[0] + b[0]) / 3) * DEG);
    const ax = wrapDeltaLon(a[1] - p.lon) * k;
    const ay = a[0] - p.lat;
    const dx = wrapDeltaLon(b[1] - a[1]) * k;
    const dy = b[0] - a[0];
    const len2 = dx * dx + dy * dy;
    let t = 0;
    if (len2 > 0) {
      t = -(ax * dx + ay * dy) / len2;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
    }
    const qx = ax + t * dx;
    const qy = ay + t * dy;
    const d2 = qx * qx + qy * qy;
    if (d2 < bestD2) {
      bestD2 = d2;
      bestIndex = i - 1;
      bestT = t;
    }
  }
  const a = line[bestIndex];
  const b = line[bestIndex + 1];
  const qLat = a[0] + bestT * (b[0] - a[0]);
  const qLon = a[1] + bestT * wrapDeltaLon(b[1] - a[1]);
  return { index: bestIndex, t: bestT, distM: havDeg(p.lat, p.lon, qLat, qLon) };
}

/**
 * Along-line distance for a nearestOnLine result.
 * @param {{index: number, t: number}} near
 * @param {{seg: number[], cum: number[], total: number}} m
 */
function alongFromNear(near, m) {
  if (m.seg.length === 0) return 0;
  const v = m.cum[near.index] + near.t * m.seg[near.index];
  return v < 0 ? 0 : v > m.total ? m.total : v;
}

/**
 * @param {LatLng|LatLonPair} pt
 * @param {number} i
 * @returns {[number, number]} [lat, lon]
 */
function latLonOf(pt, i) {
  const q = /** @type {any} */ (pt);
  const lat = Array.isArray(q) ? q[0] : q && q.lat;
  const lon = Array.isArray(q) ? q[1] : q && q.lon;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new InputError(`points[${i}] must be {lat, lon} or [lat, lon] with finite numbers`);
  }
  return [lat, lon];
}

/**
 * @param {number} precision
 * @returns {number} 10 ** precision
 */
function polylineFactor(precision) {
  if (!Number.isInteger(precision) || precision < 0 || precision > 10) {
    throw new InputError('polyline precision must be an integer from 0 to 10');
  }
  return 10 ** precision;
}

/**
 * Append one signed integer in Google polyline form.
 * Uses arithmetic instead of 32-bit bitwise ops so large values cannot overflow.
 * @param {number} v integer
 */
function encodeSigned(v) {
  let z = v < 0 ? -v * 2 - 1 : v * 2;
  let out = '';
  while (z >= 0x20) {
    out += String.fromCharCode((0x20 | z % 0x20) + 63);
    z = Math.floor(z / 0x20);
  }
  out += String.fromCharCode(z + 63);
  return out;
}

// ---- public API ----

/**
 * Great-circle distance between two points.
 * @param {LatLng} a
 * @param {LatLng} b
 * @returns {number} meters
 */
export function haversineM(a, b) {
  return havDeg(a.lat, a.lon, b.lat, b.lon);
}

/**
 * Total length of a line (sum of haversine segment lengths). 0 for fewer than 2 points.
 * @param {LatLonPair[]} line
 * @returns {number} meters
 */
export function lineLengthM(line) {
  checkLine(line);
  if (line.length < 2) return 0;
  let total = 0;
  let a = checkPair(line[0], 0);
  for (let i = 1; i < line.length; i++) {
    const b = checkPair(line[i], i);
    total += havDeg(a[0], a[1], b[0], b[1]);
    a = b;
  }
  return total;
}

/**
 * Shortest distance from a point to a line (to any segment, not just vertices).
 * A 1-point line is treated as that point. Throws InputError for an empty line.
 * @param {LatLng} p
 * @param {LatLonPair[]} line
 * @returns {number} meters
 */
export function pointToPolylineM(p, line) {
  checkLatLng(p, 'point');
  checkLine(line);
  if (line.length === 0) throw new InputError('line is empty');
  return nearestOnLine(p, line).distM;
}

/**
 * Distance along the line, from its first point, to the point on the line nearest p.
 * Used to order cameras along a route.
 * @param {LatLng} p
 * @param {LatLonPair[]} line
 * @returns {number} meters, between 0 and lineLengthM(line)
 */
export function positionAlongM(p, line) {
  checkLatLng(p, 'point');
  checkLine(line);
  if (line.length === 0) throw new InputError('line is empty');
  return alongFromNear(nearestOnLine(p, line), lineMeasure(line));
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
  if (!Array.isArray(cameras)) throw new InputError('cameras must be an array');
  checkLine(line);
  if (line.length === 0) throw new InputError('line is empty');
  const wraps = crossesAntimeridian(line); // also validates every pair
  if (typeof bufferM !== 'number' || Number.isNaN(bufferM)) {
    throw new InputError('bufferM must be a number');
  }
  if (bufferM < 0 || cameras.length === 0) return [];

  // Cheap prefilter: a camera within bufferM of the line lies inside the line's bbox grown
  // by bufferM. The slack keeps float differences at the boundary from dropping a camera.
  // Skipped when it would be wrong (a segment crosses the antimeridian, so the vertex bbox
  // does not cover the segment) or useless (an infinite buffer).
  const box = Number.isFinite(bufferM) && !wraps ? bboxAround(line, bufferM * 1.01 + 1) : null;
  const m = lineMeasure(line);

  /** @type {{cam: Camera, along: number}[]} */
  const hits = [];
  for (let i = 0; i < cameras.length; i++) {
    const cam = cameras[i];
    // A camera without a usable position has no distance to the route, so it is never "near".
    if (!cam || !Number.isFinite(cam.lat) || !Number.isFinite(cam.lon)) continue;
    if (box && !bboxContains(box, cam)) continue;
    const near = nearestOnLine(cam, line);
    if (near.distM <= bufferM) hits.push({ cam, along: alongFromNear(near, m) });
  }
  hits.sort((x, y) => {
    if (x.along !== y.along) return x.along - y.along;
    const a = String(x.cam.id);
    const b = String(y.cam.id);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return hits.map((h) => h.cam);
}

/**
 * Smallest bbox containing every point, grown by marginM on all four sides,
 * clamped to lat [-90, 90] and lon [-180, 180]. Throws InputError for no points.
 * @param {(LatLng|LatLonPair)[]} points  objects or [lat, lon] pairs, may be mixed
 * @param {number} marginM
 * @returns {BBox}
 */
export function bboxAround(points, marginM) {
  if (!Array.isArray(points) || points.length === 0) {
    throw new InputError('bboxAround needs at least one point');
  }
  if (!Number.isFinite(marginM) || marginM < 0) {
    throw new InputError('marginM must be a finite number >= 0');
  }
  let south = Infinity;
  let north = -Infinity;
  let west = Infinity;
  let east = -Infinity;
  for (let i = 0; i < points.length; i++) {
    const [lat, lon] = latLonOf(points[i], i);
    if (lat < south) south = lat;
    if (lat > north) north = lat;
    if (lon < west) west = lon;
    if (lon > east) east = lon;
  }
  if (marginM > 0) {
    const dLat = marginM / M_PER_DEG;
    south -= dLat;
    north += dLat;
    // Use the most poleward edge so every point within marginM east/west is covered.
    const maxAbsLat = Math.min(90, Math.max(Math.abs(south), Math.abs(north)));
    const k = Math.cos(maxAbsLat * DEG);
    const dLon = k > 1e-12 ? marginM / (M_PER_DEG * k) : 360;
    west -= dLon;
    east += dLon;
  }
  return {
    south: Math.max(-90, south),
    west: Math.max(-180, west),
    north: Math.min(90, north),
    east: Math.min(180, east),
  };
}

/**
 * True when the point is inside the bbox (edges inclusive).
 * @param {BBox} bbox
 * @param {LatLng} p
 * @returns {boolean}
 */
export function bboxContains(bbox, p) {
  return p.lat >= bbox.south && p.lat <= bbox.north && p.lon >= bbox.west && p.lon <= bbox.east;
}

/**
 * Smallest bbox containing both.
 * @param {BBox} a
 * @param {BBox} b
 * @returns {BBox}
 */
export function bboxUnion(a, b) {
  return {
    south: Math.min(a.south, b.south),
    west: Math.min(a.west, b.west),
    north: Math.max(a.north, b.north),
    east: Math.max(a.east, b.east),
  };
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
  checkLatLng(center, 'center');
  if (!Number.isFinite(radiusM) || radiusM < 0) {
    throw new InputError('radiusM must be a finite number >= 0');
  }
  if (!Number.isInteger(sides) || sides < 3) {
    throw new InputError('sides must be an integer >= 3');
  }
  const lat1 = center.lat * DEG;
  const lon1 = center.lon * DEG;
  const ang = radiusM / EARTH_RADIUS_M;
  const sinLat1 = Math.sin(lat1);
  const cosLat1 = Math.cos(lat1);
  const sinAng = Math.sin(ang);
  const cosAng = Math.cos(ang);
  /** @type {[number, number][]} */
  const ring = [];
  for (let i = 0; i < sides; i++) {
    // Start due north and go counterclockwise (bearing decreasing), the RFC 7946 exterior ring order.
    const brg = (-2 * Math.PI * i) / sides;
    const sinLat2 = sinLat1 * cosAng + cosLat1 * sinAng * Math.cos(brg);
    const lat2 = Math.asin(Math.max(-1, Math.min(1, sinLat2)));
    const lon2 = lon1 + Math.atan2(Math.sin(brg) * sinAng * cosLat1, cosAng - sinLat1 * sinLat2);
    ring.push([normalizeLon(lon2 / DEG), lat2 / DEG]);
  }
  ring.push([ring[0][0], ring[0][1]]);
  return ring;
}

/**
 * Decode a Google-style encoded polyline (Valhalla uses precision 6).
 * @param {string} encoded
 * @param {number} [precision=6]
 * @returns {LatLonPair[]}
 */
export function decodePolyline(encoded, precision = 6) {
  if (typeof encoded !== 'string') throw new InputError('encoded polyline must be a string');
  const factor = polylineFactor(precision);
  /** @type {LatLonPair[]} */
  const out = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  const n = encoded.length;

  const readValue = () => {
    let result = 0;
    let scale = 1;
    let byte;
    do {
      if (index >= n) throw new InputError('encoded polyline is truncated');
      byte = encoded.charCodeAt(index++) - 63;
      if (byte < 0 || byte > 0x3f) throw new InputError(`invalid polyline character at ${index - 1}`);
      result += (byte & 0x1f) * scale;
      scale *= 0x20;
    } while (byte >= 0x20);
    return result % 2 === 1 ? -(result + 1) / 2 : result / 2;
  };

  while (index < n) {
    lat += readValue();
    if (index >= n) throw new InputError('encoded polyline has a latitude without a longitude');
    lon += readValue();
    out.push([lat / factor, lon / factor]);
  }
  return out;
}

/**
 * Inverse of decodePolyline: decodePolyline(encodePolyline(x, p), p) equals x rounded to p decimals.
 * @param {LatLonPair[]} points
 * @param {number} [precision=6]
 * @returns {string}
 */
export function encodePolyline(points, precision = 6) {
  checkLine(points);
  const factor = polylineFactor(precision);
  let out = '';
  let prevLat = 0;
  let prevLon = 0;
  for (let i = 0; i < points.length; i++) {
    const [la, lo] = checkPair(points[i], i);
    // Round each absolute value (not the deltas) so error never accumulates.
    const lat = Math.round(la * factor);
    const lon = Math.round(lo * factor);
    out += encodeSigned(lat - prevLat) + encodeSigned(lon - prevLon);
    prevLat = lat;
    prevLon = lon;
  }
  return out;
}
