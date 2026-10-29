// @ts-check
/**
 * Typed coordinates ("35.28, -120.66") as a search result. The API checks for these before
 * calling a Geocoder, so pasted coordinates work offline and never hit the network.
 */

/** @typedef {import('../types.js').LatLng} LatLng */
/** @typedef {import('../types.js').Place} Place */

/** "<lat>, <lon>" or "<lat> <lon>", decimal degrees, optional signs. */
const COORDS_RE = /^\s*([-+]?\d{1,2}(?:\.\d+)?)\s*[,\s]\s*([-+]?\d{1,3}(?:\.\d+)?)\s*$/;

/**
 * The point typed as "lat, lon", or null when the text is not a pair of in-range coordinates.
 * @param {string} text
 * @returns {LatLng|null}
 */
export function parseCoordinates(text) {
  const m = COORDS_RE.exec(text);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

/**
 * The typed coordinates as a single Place.
 * @param {LatLng} p
 * @returns {Place}
 */
export function coordinatePlace(p) {
  return { name: `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`, detail: 'Coordinates', lat: p.lat, lon: p.lon };
}
