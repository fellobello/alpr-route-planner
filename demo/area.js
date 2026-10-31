// @ts-check
/**
 * The area the portfolio demo covers: San Luis Obispo, Los Osos and Morro Bay. Shared by the
 * camera snapshot (demo/snapshot.js) and the demo's in-browser API (demo/transport.js).
 * Edges sit on Overpass tile lines (0.1 degree), so the snapshot is whole tiles.
 */

/** @type {import('../src/types.js').BBox} */
export const DEMO_AREA = Object.freeze({ south: 35.2, west: -120.9, north: 35.4, east: -120.6 });

/** @param {{lat: number, lon: number}} p */
export function inDemoArea(p) {
  return p.lat >= DEMO_AREA.south && p.lat <= DEMO_AREA.north && p.lon >= DEMO_AREA.west && p.lon <= DEMO_AREA.east;
}
