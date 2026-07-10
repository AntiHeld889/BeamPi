import fs from 'node:fs';
import path from 'node:path';

function isWithin(base, candidate) {
  return candidate === base || candidate.startsWith(base + path.sep);
}

/**
 * Löst einen relativen Pfad innerhalb eines Basisordners auf. Neben `..` werden
 * auch Symlinks geprüft: existiert das Ziel noch nicht, muss zumindest sein
 * nächster existierender Elternordner real innerhalb des Basisordners liegen.
 *
 * @returns {string|null} lexikalisch absoluter Pfad oder null bei einem Ausbruch
 */
export function resolveContainedPath(baseDir, relativePath, { allowBase = true } = {}) {
  if (typeof relativePath !== 'string' || relativePath.includes('\0')) return null;

  const base = path.resolve(baseDir);
  const absolute = path.resolve(base, relativePath);
  if (!isWithin(base, absolute) || (!allowBase && absolute === base)) return null;

  let realBase;
  try {
    realBase = fs.realpathSync(base);
  } catch {
    return null;
  }

  let existing = absolute;
  while (true) {
    try {
      const realExisting = fs.realpathSync(existing);
      return isWithin(realBase, realExisting) ? absolute : null;
    } catch (err) {
      if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') return null;
      const parent = path.dirname(existing);
      if (parent === existing) return null;
      existing = parent;
    }
  }
}
