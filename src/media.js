import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Videodauern (ffprobe) und Thumbnails (ffmpeg) mit Cache auf der Platte.
 * Dauern werden im Hintergrund seriell ermittelt (ein ffprobe gleichzeitig,
 * damit der Pi nicht einbricht); Thumbnails entstehen on-demand pro Request.
 */
export class MediaMeta {
  #cacheFile;
  #thumbDir;
  #cache = new Map(); // rel -> { size, mtimeMs, duration }
  #queue = [];
  #queued = new Set();
  #probing = false;
  #saveTimer = null;
  #inflightThumbs = new Map(); // key -> Promise<string|null>
  #failedThumbs = new Map(); // key -> Zeitpunkt des letzten Fehlversuchs (ms)
  #FAILED_RETRY_MS = 5 * 60 * 1000; // nach 5 min erneut versuchen (transiente Last)

  constructor(dataDir, getVideoDirectory) {
    this.getVideoDirectory = getVideoDirectory;
    this.#cacheFile = path.join(dataDir, 'media-meta.json');
    this.#thumbDir = path.join(dataDir, 'thumbs');
    fs.mkdirSync(this.#thumbDir, { recursive: true });
    try {
      const stored = JSON.parse(fs.readFileSync(this.#cacheFile, 'utf8'));
      for (const [rel, entry] of Object.entries(stored)) this.#cache.set(rel, entry);
    } catch {
      /* kein Cache vorhanden */
    }
  }

  #key(rel, stat) {
    return crypto
      .createHash('sha1')
      .update(`${rel}:${stat.size}:${Math.round(stat.mtimeMs)}`)
      .digest('hex');
  }

  #statFor(rel) {
    try {
      const absolute = path.resolve(this.getVideoDirectory(), rel);
      const stat = fs.statSync(absolute);
      return stat.isFile() ? { absolute, stat } : null;
    } catch {
      return null;
    }
  }

  /** Gecachte Dauer in Sekunden oder null. */
  durationFor(rel, size, mtimeMs) {
    const entry = this.#cache.get(rel);
    if (!entry) return null;
    if (entry.size !== size || Math.round(entry.mtimeMs) !== Math.round(mtimeMs)) return null;
    return entry.duration ?? null;
  }

  /** Fehlende Dauern im Hintergrund nachziehen. */
  ensureDurations(files) {
    for (const file of files) {
      if (this.durationFor(file.path, file.size, file.mtimeMs) !== null) continue;
      if (this.#queued.has(file.path)) continue;
      this.#queued.add(file.path);
      this.#queue.push(file.path);
    }
    this.#pumpProbe();
  }

  async #pumpProbe() {
    if (this.#probing) return;
    this.#probing = true;
    try {
      while (this.#queue.length > 0) {
        const rel = this.#queue.shift();
        this.#queued.delete(rel);
        const found = this.#statFor(rel);
        if (!found) continue;
        const duration = await this.#probeDuration(found.absolute);
        this.#cache.set(rel, {
          size: found.stat.size,
          mtimeMs: found.stat.mtimeMs,
          duration,
        });
        this.#scheduleSave();
      }
    } finally {
      this.#probing = false;
    }
  }

  #probeDuration(absolute) {
    return new Promise((resolve) => {
      execFile(
        'ffprobe',
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', absolute],
        { timeout: 15000 },
        (err, stdout) => {
          if (err) {
            resolve(null);
            return;
          }
          const seconds = Number.parseFloat(String(stdout).trim());
          resolve(Number.isFinite(seconds) ? Math.round(seconds * 10) / 10 : null);
        }
      );
    });
  }

  #scheduleSave() {
    clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => {
      try {
        fs.writeFileSync(this.#cacheFile, JSON.stringify(Object.fromEntries(this.#cache)));
      } catch {
        /* Cache ist verzichtbar */
      }
    }, 1000);
  }

  /**
   * Thumbnail-Datei für ein Video liefern (bei Bedarf erzeugen).
   * @returns {Promise<string|null>} absoluter Pfad zum JPEG oder null
   */
  async thumbnail(rel) {
    const found = this.#statFor(rel);
    if (!found) return null;
    const key = this.#key(rel, found.stat);
    const file = path.join(this.#thumbDir, `${key}.jpg`);
    if (fs.existsSync(file)) return file;
    const failedAt = this.#failedThumbs.get(key);
    if (failedAt !== undefined && Date.now() - failedAt < this.#FAILED_RETRY_MS) return null;
    if (this.#inflightThumbs.has(key)) return this.#inflightThumbs.get(key);

    const job = this.#generateThumb(found.absolute, file)
      .then((ok) => {
        if (ok) this.#failedThumbs.delete(key);
        else this.#failedThumbs.set(key, Date.now());
        return ok ? file : null;
      })
      .finally(() => this.#inflightThumbs.delete(key));
    this.#inflightThumbs.set(key, job);
    return job;
  }

  async #generateThumb(absolute, outFile) {
    // Frame bei Sekunde 1; bei sehr kurzen Videos Fallback auf Frame 0
    for (const seek of ['1', '0']) {
      const ok = await new Promise((resolve) => {
        execFile(
          'ffmpeg',
          ['-y', '-loglevel', 'error', '-ss', seek, '-i', absolute,
            '-frames:v', '1', '-vf', 'scale=240:-2', '-q:v', '5', outFile],
          { timeout: 20000 },
          (err) => resolve(!err && fs.existsSync(outFile) && fs.statSync(outFile).size > 0)
        );
      });
      if (ok) return true;
    }
    return false;
  }
}
