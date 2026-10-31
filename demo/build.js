// @ts-check
/**
 * Assemble the portfolio demo: the browser app from public/, the shared modules it needs from
 * src/, the San Luis Obispo camera snapshot, and demo/transport.js in place of the HTTP one.
 * Writes to ../fellobello.github.io/projects/alpr-demo/ unless a folder is given:
 *   npm run demo [-- <out dir>]
 */
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const here = fileURLToPath(new URL('.', import.meta.url));
const out = path.resolve(process.argv[2] ?? path.join(root, '../fellobello.github.io/projects/alpr-demo'));

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(path.join(root, 'public'), out, { recursive: true });
// No install prompt for a page inside the portfolio.
rmSync(path.join(out, 'manifest.webmanifest'));

const SRC_FILES = [
  'types.js',
  'api.js',
  'planner.js',
  'geo.js',
  'routing/valhalla.js',
  'geocode/coordinates.js',
  'geocode/nominatim.js',
];
for (const f of SRC_FILES) {
  const to = path.join(out, 'src', f);
  mkdirSync(path.dirname(to), { recursive: true });
  cpSync(path.join(root, 'src', f), to);
}
for (const f of ['transport.js', 'area.js', 'slo-cameras.json']) cpSync(path.join(here, f), path.join(out, f));

const indexFile = path.join(out, 'index.html');
const html = readFileSync(indexFile, 'utf8')
  .replace('<title>ALPR Route Planner</title>', '<title>ALPR Route Planner demo</title>')
  .replace(/\s*<link rel="manifest"[^>]*>/, '');
writeFileSync(indexFile, html);

const files = readdirSync(out, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).length;
console.log(`demo ready in ${out} (${files} files)`);
