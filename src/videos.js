import fs from 'node:fs';
import path from 'node:path';

export const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.mkv', '.mov', '.avi', '.mpg', '.mpeg', '.webm', '.m4v', '.wmv',
]);

export function isVideoFile(name) {
  return VIDEO_EXTENSIONS.has(path.extname(name).toLowerCase());
}

/**
 * Liefert alle Videodateien unterhalb von `dir` als sortierte Einträge
 * mit POSIX-relativem Pfad, Größe und Änderungszeit.
 */
export function scanVideos(dir) {
  const base = path.resolve(dir);
  if (!fs.existsSync(base)) return [];
  let entries;
  try {
    entries = fs.readdirSync(base, { recursive: true, withFileTypes: true });
  } catch {
    return [];
  }
  const videos = [];
  for (const entry of entries) {
    if (!entry.isFile() || !isVideoFile(entry.name)) continue;
    const absolute = path.join(entry.parentPath, entry.name);
    const relative = path.relative(base, absolute).split(path.sep).join('/');
    let stat;
    try {
      stat = fs.statSync(absolute);
    } catch {
      continue;
    }
    videos.push({ path: relative, size: stat.size, mtimeMs: stat.mtimeMs });
  }
  videos.sort((a, b) => a.path.localeCompare(b.path, 'de'));
  return videos;
}

/**
 * Baut aus relativen Pfaden einen Baum:
 * [{ name, path, is_file, children: [...] }], Ordner vor Dateien.
 */
export function buildVideoTree(relativePaths) {
  const root = { dirs: new Map(), files: [] };

  for (const relative of relativePaths) {
    const parts = relative.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i];
      if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] });
      node = node.dirs.get(part);
    }
    node.files.push({ name: parts[parts.length - 1], path: relative });
  }

  const toNodes = (node, prefix) => {
    const dirs = [...node.dirs.keys()]
      .sort((a, b) => a.localeCompare(b, 'de'))
      .map((name) => ({
        name,
        path: `${prefix}${name}`,
        is_file: false,
        children: toNodes(node.dirs.get(name), `${prefix}${name}/`),
      }));
    const files = node.files
      .sort((a, b) => a.name.localeCompare(b.name, 'de'))
      .map((file) => ({ name: file.name, path: file.path, is_file: true, children: [] }));
    return [...dirs, ...files];
  };

  return toNodes(root, '');
}

/** Gecachte Video-Liste mit kurzer TTL, damit per SFTP kopierte Dateien auch auftauchen. */
export class VideoLibrary {
  #cache = null;
  #cachedAt = 0;
  #cachedDir = null;
  #ttlMs;

  constructor(getDirectory, ttlMs = 3000) {
    this.getDirectory = getDirectory;
    this.#ttlMs = ttlMs;
  }

  invalidate() {
    this.#cache = null;
  }

  /** @returns {Array<{path: string, size: number, mtimeMs: number}>} */
  listDetailed() {
    const dir = this.getDirectory();
    const fresh =
      this.#cache !== null &&
      this.#cachedDir === dir &&
      Date.now() - this.#cachedAt < this.#ttlMs;
    if (!fresh) {
      this.#cache = scanVideos(dir);
      this.#cachedAt = Date.now();
      this.#cachedDir = dir;
    }
    return this.#cache;
  }

  /** Nur die relativen Pfade. */
  list() {
    return this.listDetailed().map((file) => file.path);
  }

  tree() {
    return buildVideoTree(this.list());
  }
}
