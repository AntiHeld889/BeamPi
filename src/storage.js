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
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        console.warn(`JSON-Datei konnte nicht gelesen werden (${file}): ${err.message}`);
      }
      return fallback;
    }
    try {
      return JSON.parse(raw);
    } catch (err) {
      const backup = `${file}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(file, backup);
        console.warn(`Kaputte JSON-Datei gesichert: ${backup}`);
      } catch (backupErr) {
        console.warn(`Kaputte JSON-Datei konnte nicht gesichert werden (${file}): ${backupErr.message}`);
      }
      console.warn(`JSON-Datei wird mit Standardwerten ersetzt (${file}): ${err.message}`);
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
        gpio_pin: Number.isInteger(payload?.gpio_pin) ? payload.gpio_pin : null,
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
        gpio_pin: Number.isInteger(playlist.gpio_pin) ? playlist.gpio_pin : null,
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
