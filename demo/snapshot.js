// @ts-check
/**
 * Save every mapped camera in the demo area to demo/slo-cameras.json, so the portfolio demo
 * makes no Overpass calls. Uses the server's tile cache (data/cache/) like npm start does, so
 * when Overpass is down the last cached tiles are saved instead. Refresh: npm run demo:snapshot
 */
import { writeFileSync } from 'node:fs';
import { OVERPASS_ENDPOINTS, OverpassCameraSource } from '../src/cameras/overpass.js';
import { DEFAULT_CACHE_FILE, FileTileStore } from '../src/cameras/tile-store.js';
import { DEMO_AREA } from './area.js';

const source = new OverpassCameraSource({ endpoints: OVERPASS_ENDPOINTS, store: new FileTileStore(DEFAULT_CACHE_FILE) });
const cameras = await source.getCameras(DEMO_AREA);
cameras.sort((a, b) => a.id.localeCompare(b.id));
const out = new URL('slo-cameras.json', import.meta.url);
writeFileSync(out, JSON.stringify({ savedAt: new Date().toLocaleDateString('en-CA'), area: DEMO_AREA, cameras }) + '\n');
console.log(`${cameras.length} cameras (${cameras.filter((c) => c.isFlock).length} Flock) saved to demo/slo-cameras.json`);
