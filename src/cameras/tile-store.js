// @ts-check
/**
 * Keeps Overpass tiles in a JSON file so a restart, or a slow or down Overpass, does not mean
 * an empty map. Node only; the Android app keeps its tiles in localStorage instead.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** @typedef {import('./overpass.js').StoredTile} StoredTile */

export const DEFAULT_CACHE_FILE = new URL('../../data/cache/overpass-tiles.json', import.meta.url);

/** Writes are grouped: at most one per this many milliseconds. */
const SAVE_DELAY_MS = 2000;

const FORMAT = 1;

/** @type {Set<FileTileStore>} */
const stores = new Set();

/** @implements {import('./overpass.js').TileStore} */
export class FileTileStore {
  /** @param {string|URL} [file=DEFAULT_CACHE_FILE] */
  constructor(file = DEFAULT_CACHE_FILE) {
    this.file = file instanceof URL ? file.pathname : file;
    /** @type {StoredTile[]|null} */
    this._pending = null;
    /** @type {ReturnType<typeof setTimeout>|null} */
    this._timer = null;
    stores.add(this);
  }

  /** Write every store's waiting save (on shutdown). */
  static flushAll() {
    for (const s of stores) s.flush();
  }

  /** @returns {StoredTile[]} */
  load() {
    let text;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch (err) {
      if (/** @type {{code?: string}} */ (err).code === 'ENOENT') return [];
      throw err;
    }
    const data = JSON.parse(text);
    return data && data.format === FORMAT && Array.isArray(data.tiles) ? data.tiles : [];
  }

  /** @param {StoredTile[]} tiles */
  save(tiles) {
    this._pending = tiles;
    if (this._timer) return;
    this._timer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
    this._timer.unref?.();
  }

  /** Write any waiting save now (also called on shutdown). */
  flush() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    const tiles = this._pending;
    this._pending = null;
    if (!tiles) return;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ format: FORMAT, savedAt: new Date().toISOString(), tiles }));
      renameSync(tmp, this.file); // atomic: a crash mid-write never leaves a half file
    } catch (err) {
      console.warn(`[overpass] could not write ${this.file}: ${err instanceof Error ? err.message : err}`);
    }
  }
}
