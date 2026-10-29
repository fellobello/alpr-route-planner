// Assemble mobile/www for Capacitor: the browser app from public/, the shared modules it needs
// from src/ (everything but the Node server and the offline sample source), and the on-device
// transport in place of the HTTP one.
import { cpSync, existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../../', import.meta.url);
const www = new URL('../www/', import.meta.url);
const p = (/** @type {URL} */ u) => fileURLToPath(u);

rmSync(p(www), { recursive: true, force: true });
mkdirSync(p(www), { recursive: true });
cpSync(p(new URL('public/', root)), p(www), { recursive: true });

const SRC_FILES = [
  'types.js',
  'api.js',
  'planner.js',
  'geo.js',
  'cameras/common.js',
  'cameras/overpass.js',
  'routing/valhalla.js',
  'geocode/coordinates.js',
  'geocode/nominatim.js',
];
for (const f of SRC_FILES) {
  const to = new URL(`src/${f}`, www);
  mkdirSync(p(new URL('.', to)), { recursive: true });
  cpSync(p(new URL(`src/${f}`, root)), p(to));
}
cpSync(p(new URL('../web/transport.js', import.meta.url)), p(new URL('transport.js', www)));

// Starter camera data: whatever the server has cached (npm start, then browse an area).
const seed = new URL('data/cache/overpass-tiles.json', root);
if (existsSync(p(seed))) cpSync(p(seed), p(new URL('overpass-seed.json', www)));

const count = (/** @type {URL} */ dir) =>
  readdirSync(p(dir), { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).length;
console.log(`mobile/www ready (${count(www)} files)`);
