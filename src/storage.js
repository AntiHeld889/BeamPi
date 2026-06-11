import fs from 'node:fs';
import path from 'node:path';

/**
 * Thread-safe is unnecessary in Node (single event loop), but writes are
 * atomic (tmp + rename), damit ein Stromausfall am Pi keine kaputten
 * JSON-Dateien hinterlässt.
 */
export class Storage {
  constructor(baseDir) {
    this.baseDir = path.resolve(baseDir);
    fs.mkdirSync(this.baseDir, { recursive: true });
    this.playlistsPath = path.join(this.baseDir, 'playlists.json');
    this.settingsPath = path.join(this.baseDir, 'settings.json');
  }

  #readJson(file, fallback) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return fallback;
    }
  }

  #writeJson(file, payload) {
    const tmp = `${file}.tmp`;
    // fsync vor rename, sonst kann ext4 nach Stromausfall eine leere Datei
    // hinterlassen (rename committet vor den Daten)
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, JSON.stringify(payload, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  }

  loadPlaylists() {
    const data = this.#readJson(this.playlistsPath, {});
    const playlists = new Map();
    for (const [name, payload] of Object.entries(data)) {
      playlists.set(name, {
        name: String(payload?.name ?? name),
        loop_video: payload?.loop_video || null,
        videos: Array.isArray(payload?.videos) ? payload.videos.map(String) : [],
      });
    }
    return playlists;
  }

  savePlaylists(playlists) {
    const payload = {};
    for (const [name, playlist] of playlists) {
      payload[name] = {
        name: playlist.name,
        loop_video: playlist.loop_video || null,
        videos: playlist.videos,
      };
    }
    this.#writeJson(this.playlistsPath, payload);
  }

  loadSettings() {
    return this.#readJson(this.settingsPath, {});
  }

  saveSettings(settings) {
    this.#writeJson(this.settingsPath, settings);
  }
}
